import { cors } from "hono/cors";
import { Hono } from "hono";
import { z } from "zod";
import type { Config } from "./config.js";
import { seedDemo } from "./demoData.js";
import { DecisionEngine } from "./engine.js";
import { runMcpAudit } from "./mcpAudit.js";
import { NotFoundError, StaleRevisionError, CockroachRepository } from "./repository.js";
import { ReceiptPublisher } from "./receipts.js";
import { BedrockDecisionReasoner } from "./reasoner.js";

const incidentSchema = z.object({
  tenantId: z.string().min(2).max(80).default("demo-logistics"),
  supplier: z.string().min(2).max(120),
  shipmentRef: z.string().min(2).max(80),
  category: z.enum(["delay", "quality", "capacity", "compliance"]),
  severity: z.number().int().min(1).max(5),
  summary: z.string().min(12).max(1000),
  sessionId: z.string().min(4).max(120),
  actor: z.string().min(2).max(120).default("demo-operator"),
});

const transitionSchema = z.object({
  tenantId: z.string().default("demo-logistics"),
  expectedRevision: z.number().int().positive(),
  actor: z.string().default("demo-operator"),
  sessionId: z.string().min(4),
});

const memoryStatusSchema = z.object({
  tenantId: z.string().default("demo-logistics"),
  actor: z.string().default("demo-operator"),
  sessionId: z.string().min(4),
  reason: z.string().min(4).max(500),
});

function keyFromHeader(value: string | undefined): string {
  if (!value || value.length < 8 || value.length > 160) {
    throw new Error("Idempotency-Key header must contain 8-160 characters");
  }
  return value;
}

export function createApp(config: Config) {
  const repository = new CockroachRepository(config.databaseUrl);
  const engine = new DecisionEngine(
    repository,
    config.bedrockModelId ? new BedrockDecisionReasoner(config.bedrockModelId, config.awsRegion) : undefined,
  );
  const receipts = new ReceiptPublisher(repository, {
    bucket: config.evidenceBucket,
    region: config.awsRegion,
  });
  const app = new Hono();

  app.use("*", cors({
    origin: "*",
    allowHeaders: ["Content-Type", "Idempotency-Key", "X-RecallOps-Fault"],
    allowMethods: ["GET", "POST", "OPTIONS"],
  }));

  app.onError((error, context) => {
    if (error instanceof z.ZodError) {
      return context.json({ error: "validation_failed", details: error.issues }, 400);
    }
    if (error instanceof StaleRevisionError) {
      return context.json(
        {
          error: "stale_revision",
          expectedRevision: error.expectedRevision,
          actualRevision: error.actualRevision,
        },
        409,
      );
    }
    if (error instanceof NotFoundError) return context.json({ error: "not_found", message: error.message }, 404);
    if (error.message.startsWith("Idempotency-Key")) return context.json({ error: "invalid_idempotency_key" }, 400);
    console.error(error);
    return context.json({ error: "internal_error", message: "The operation failed safely." }, 500);
  });

  app.get("/health", async (context) => {
    const health = await repository.health();
    return context.json({
      status: "ok",
      service: "recallops-agent-api",
      database: health,
      awsReceiptSink: config.evidenceBucket ? "amazon-s3" : "local-file-evidence-sink",
    });
  });

  app.get("/v1/incidents", async (context) => {
    const tenantId = context.req.query("tenantId") ?? config.demoTenantId;
    return context.json({ incidents: await repository.listIncidents(tenantId) });
  });

  app.post("/v1/incidents", async (context) => {
    const command = incidentSchema.parse(await context.req.json());
    const idempotencyKey = keyFromHeader(context.req.header("Idempotency-Key"));
    const bundle = await engine.process(command, idempotencyKey);
    if (context.req.header("X-RecallOps-Fault") === "after-commit" && !bundle.idempotentReplay) {
      return context.json(
        {
          error: "simulated_response_loss_after_commit",
          recovery: "Repeat the same command with the same Idempotency-Key.",
          committedIncidentId: bundle.incident.incidentId,
        },
        503,
      );
    }
    return context.json(bundle, bundle.idempotentReplay ? 200 : 201);
  });

  app.get("/v1/incidents/:incidentId", async (context) => {
    const tenantId = context.req.query("tenantId") ?? config.demoTenantId;
    return context.json(await repository.getIncident(tenantId, context.req.param("incidentId")));
  });

  app.get("/v1/incidents/:incidentId/timeline", async (context) => {
    const tenantId = context.req.query("tenantId") ?? config.demoTenantId;
    return context.json({ events: await repository.timeline(tenantId, context.req.param("incidentId")) });
  });

  app.post("/v1/actions/:actionId/:transition", async (context) => {
    const body = transitionSchema.parse(await context.req.json());
    const transition = context.req.param("transition");
    if (!new Set(["approve", "compensate", "reject"]).has(transition)) {
      return context.json({ error: "invalid_transition" }, 400);
    }
    const targetState = transition === "approve" ? "approved" : transition === "compensate" ? "compensated" : "rejected";
    const action = await repository.transitionAction({
      ...body,
      actionId: context.req.param("actionId"),
      targetState,
      idempotencyKey: keyFromHeader(context.req.header("Idempotency-Key")),
    });
    return context.json({ action });
  });

  app.post("/v1/memories/:memoryId/:transition", async (context) => {
    const body = memoryStatusSchema.parse(await context.req.json());
    const transition = context.req.param("transition");
    if (!new Set(["revoke", "restore"]).has(transition)) {
      return context.json({ error: "invalid_transition" }, 400);
    }
    const memory = await repository.setMemoryStatus({
      ...body,
      memoryId: context.req.param("memoryId"),
      status: transition === "revoke" ? "revoked" : "active",
      idempotencyKey: keyFromHeader(context.req.header("Idempotency-Key")),
    });
    return context.json({ memory });
  });

  app.get("/v1/evidence", async (context) => {
    const tenantId = context.req.query("tenantId") ?? config.demoTenantId;
    return context.json(await repository.evidence(tenantId));
  });

  app.post("/v1/evidence/flush", async (context) => {
    const body = z.object({ tenantId: z.string().default(config.demoTenantId) }).parse(await context.req.json());
    return context.json(await receipts.flush(body.tenantId));
  });

  app.post("/v1/mcp/audit", async (context) => {
    if (!config.mcpClusterId || !config.mcpApiKey) {
      return context.json({
        error: "mcp_not_configured",
        message: "Configure a read-only CockroachDB Cloud service account to run the live audit.",
      }, 503);
    }
    return context.json(await runMcpAudit({
      serverUrl: config.mcpServerUrl,
      clusterId: config.mcpClusterId,
      apiKey: config.mcpApiKey,
    }));
  });

  app.post("/v1/demo/reset", async (context) => {
    const tenantId = config.demoTenantId;
    await repository.resetDemoTenant(tenantId);
    await seedDemo(repository, tenantId);
    return context.json({ status: "reset", tenantId, memoriesSeeded: 3 });
  });

  return { app, repository };
}
