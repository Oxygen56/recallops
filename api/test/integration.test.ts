import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { seedDemo } from "../src/demoData.js";
import { deterministicEmbedding, vectorLiteral } from "../src/embedding.js";
import { DecisionEngine } from "../src/engine.js";
import {
  CockroachRepository,
  IdempotencyConflictError,
  QuotaExceededError,
  StaleRevisionError,
} from "../src/repository.js";
import { ReceiptPublisher } from "../src/receipts.js";
import { runSafetyEvaluation } from "../src/safetyEval.js";

const config = loadConfig();
const repository = new CockroachRepository(config.databaseUrl);
const engine = new DecisionEngine(repository);
const { app: httpApp, repository: httpRepository } = createApp(config);
const tenantId = config.demoTenantId;

describe("CockroachDB incident memory integration", () => {
  beforeAll(async () => {
    await repository.health();
    await repository.resetDemoTenant(tenantId);
    await seedDemo(repository, tenantId);
  });

  afterAll(async () => {
    await repository.close();
    await httpRepository.close();
  });

  it("uses the distributed vector index and excludes expired memory", async () => {
    const evidence = await repository.evidence(tenantId);
    expect(evidence.vectorIndex).toBe("memory_semantic_idx:active");
    const query = deterministicEmbedding("port delay carrier milestone");
    const before = await repository.retrieveMemories(tenantId, query, 10);
    expect(before.length).toBeGreaterThan(0);

    await repository.seedMemory({
      tenantId,
      kind: "expired-test",
      content: "port delay carrier milestone expired sentinel",
      embedding: query,
      provenance: { synthetic: true },
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const after = await repository.retrieveMemories(tenantId, query, 20);
    expect(after.some((memory) => memory.kind === "expired-test")).toBe(false);

    const denseTenant = `eval-${randomUUID()}`;
    const live = await repository.seedMemory({
      tenantId: denseTenant,
      kind: "dense-live-sentinel",
      content: "port delay carrier milestone live sentinel",
      embedding: query,
      provenance: { synthetic: true },
    });
    try {
      await repository.pool.query(
        `INSERT INTO memory_records
           (tenant_id, kind, content, embedding, provenance, expires_at)
         SELECT $1, 'dense-expired-sentinel', 'expired perfect match ' || value::STRING,
                $2::VECTOR, '{"synthetic":true}'::JSONB, now() - INTERVAL '1 minute'
           FROM generate_series(1, 80) AS rows(value)`,
        [denseTenant, vectorLiteral(query)],
      );
      const denseResults = await repository.retrieveMemories(denseTenant, query, 1);
      expect(denseResults.map((memory) => memory.memoryId)).toContain(live.memoryId);
    } finally {
      await repository.deleteEvaluationTenants([denseTenant]);
    }
  });

  it("deduplicates retries and preserves cross-session context", async () => {
    const idempotencyKey = `test-incident-${randomUUID()}`;
    const command = {
      tenantId,
      supplier: "HarborLine Logistics",
      shipmentRef: "HL-2048",
      category: "delay" as const,
      severity: 4,
      summary: "Carrier milestone is missing after a six-day port congestion delay.",
      sessionId: "shift-a-session",
      actor: "analyst-a",
    };
    const first = await engine.process(command, idempotencyKey);
    const replay = await engine.process(command, idempotencyKey);
    expect(replay.incident.incidentId).toBe(first.incident.incidentId);
    expect(replay.actions.map((action) => action.actionId)).toEqual(
      first.actions.map((action) => action.actionId),
    );
    expect(replay.idempotentReplay).toBe(true);
    await expect(engine.process({ ...command, summary: "A different command reuses the same key." }, idempotencyKey))
      .rejects.toBeInstanceOf(IdempotencyConflictError);

    const nextSession = await engine.process(
      {
        ...command,
        shipmentRef: "HL-2051",
        summary: "A new port delay has the same missing carrier milestone pattern.",
        sessionId: "shift-b-session",
        actor: "analyst-b",
      },
      `test-cross-session-${randomUUID()}`,
    );
    expect(nextSession.similarMemories.some((memory) => memory.memoryId === first.memory.memoryId)).toBe(true);
  });

  it("returns an HTTP 503 after commit and reconciles the replay without duplicate rows", async () => {
    const idempotencyKey = `http-fault-${randomUUID()}`;
    const command = {
      tenantId,
      supplier: "HarborLine Logistics",
      shipmentRef: `HTTP-FAULT-${randomUUID().slice(0, 8)}`,
      category: "delay",
      severity: 4,
      summary: "The API commits the incident, loses the response, and must reconcile the retry safely.",
      sessionId: "http-fault-session",
      actor: "http-fault-operator",
    };
    const failedResponse = await httpApp.request("/v1/incidents", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
        "X-RecallOps-Fault": "after-commit",
      },
      body: JSON.stringify(command),
    });
    expect(failedResponse.status).toBe(503);
    const failed = await failedResponse.json() as { committedIncidentId: string };

    const replayResponse = await httpApp.request("/v1/incidents", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(command),
    });
    expect(replayResponse.status).toBe(200);
    const replay = await replayResponse.json() as {
      idempotentReplay: boolean;
      incident: { incidentId: string };
      actions: unknown[];
    };
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.incident.incidentId).toBe(failed.committedIncidentId);
    const rows = await repository.aggregateEvidence(tenantId, replay.incident.incidentId);
    expect(rows).toMatchObject({
      incidents: 1,
      memories: 1,
      actions: replay.actions.length,
      createdEvents: 1,
    });
  });

  it("enforces the public demo tenant boundary and database-backed hourly quota", async () => {
    const forbidden = await httpApp.request("/v1/incidents?tenantId=another-tenant");
    expect(forbidden.status).toBe(403);

    const suffix = randomUUID().replaceAll(/[^a-f]/g, "a").slice(0, 8);
    const scope = `test-quota-${suffix}`;
    await repository.acquireDemoQuota(scope, 2);
    await repository.acquireDemoQuota(scope, 2);
    await expect(repository.acquireDemoQuota(scope, 2)).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it("serializes live safety gates with a database lease across repository instances", async () => {
    const otherRepository = new CockroachRepository(config.databaseUrl, 1);
    const firstHolder = randomUUID();
    const secondHolder = randomUUID();
    try {
      expect(await repository.acquireEvaluationLease(firstHolder)).toBe(true);
      expect(await otherRepository.acquireEvaluationLease(secondHolder)).toBe(false);
      await repository.releaseEvaluationLease(firstHolder);
      expect(await otherRepository.acquireEvaluationLease(secondHolder)).toBe(true);
    } finally {
      await repository.releaseEvaluationLease(firstHolder);
      await otherRepository.releaseEvaluationLease(secondHolder);
      await otherRepository.close();
    }
  });

  it("allows only one concurrent transition at a known revision", async () => {
    const created = await engine.process(
      {
        tenantId,
        supplier: "Atlas Components",
        shipmentRef: "AC-901",
        category: "quality",
        severity: 5,
        summary: "Inspection found coating defects across samples from the current lot.",
        sessionId: "quality-session",
        actor: "quality-lead",
      },
      `test-concurrency-${randomUUID()}`,
    );
    const action = created.actions[0];
    const attempts = await Promise.allSettled(
      ["one", "two"].map((suffix) =>
        repository.transitionAction({
          tenantId,
          actionId: action.actionId,
          expectedRevision: 1,
          targetState: "approved",
          actor: `reviewer-${suffix}`,
          sessionId: `concurrent-${suffix}`,
          idempotencyKey: `test-action-${suffix}-${randomUUID()}`,
        }),
      ),
    );
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = attempts.find((result) => result.status === "rejected");
    expect(rejection).toBeDefined();
    if (rejection?.status === "rejected") {
      expect(
        rejection.reason instanceof StaleRevisionError ||
          String(rejection.reason).includes("cannot approve action"),
      ).toBe(true);
    }
  });

  it("reconciles concurrent identical action retries and rejects key reuse", async () => {
    const created = await engine.process({
      tenantId,
      supplier: "HarborLine Logistics",
      shipmentRef: "ACTION-IDEMPOTENCY-1",
      category: "delay",
      severity: 3,
      summary: "The same approval request is retried concurrently after a client timeout.",
      sessionId: "action-retry-session",
      actor: "operations-lead",
    }, `test-action-parent-${randomUUID()}`);
    const action = created.actions[0];
    const key = `test-action-identical-${randomUUID()}`;
    const request = {
      tenantId,
      actionId: action.actionId,
      expectedRevision: action.revision,
      targetState: "approved" as const,
      actor: "operations-lead",
      sessionId: "action-retry-session",
      idempotencyKey: key,
    };
    const identical = await Promise.all([
      repository.transitionAction(request),
      repository.transitionAction(request),
    ]);
    expect(identical[0]).toEqual(identical[1]);
    expect(identical[0]).toMatchObject({ state: "approved", revision: 2 });
    const counts = await repository.aggregateEvidence(tenantId, created.incident.incidentId);
    expect(counts.approvedEvents).toBe(1);
    await expect(repository.transitionAction({
      ...request,
      actionId: created.actions[1].actionId,
    })).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("revokes memory from retrieval and can restore it with an audit event", async () => {
    const created = await engine.process(
      {
        tenantId,
        supplier: "Atlas Components",
        shipmentRef: "AC-REV-1",
        category: "quality",
        severity: 3,
        summary: "A reversible test incident validates memory lifecycle behavior.",
        sessionId: "lifecycle-a",
        actor: "quality-lead",
      },
      `test-lifecycle-${randomUUID()}`,
    );
    const noOpRequest = {
      tenantId,
      memoryId: created.memory.memoryId,
      status: "active",
      actor: "quality-lead",
      sessionId: "lifecycle-noop",
      idempotencyKey: `test-noop-${randomUUID()}`,
      reason: "An already-active memory remains active.",
    } as const;
    const noOp = await repository.setMemoryStatus(noOpRequest);
    expect(await repository.setMemoryStatus(noOpRequest)).toEqual(noOp);
    await expect(repository.setMemoryStatus({ ...noOpRequest, status: "revoked" }))
      .rejects.toBeInstanceOf(IdempotencyConflictError);
    const revokeKey = `test-revoke-${randomUUID()}`;
    const revokeRequest = {
      tenantId,
      memoryId: created.memory.memoryId,
      status: "revoked",
      actor: "quality-lead",
      sessionId: "lifecycle-b",
      idempotencyKey: revokeKey,
      reason: "Source evidence was superseded.",
    } as const;
    const revoked = await repository.setMemoryStatus(revokeRequest);
    const revokeReplay = await repository.setMemoryStatus(revokeRequest);
    expect(revokeReplay).toEqual(revoked);
    await expect(repository.setMemoryStatus({ ...revokeRequest, reason: "Different request." }))
      .rejects.toBeInstanceOf(IdempotencyConflictError);
    const query = deterministicEmbedding(created.memory.content);
    const revokedResults = await repository.retrieveMemories(tenantId, query, 30);
    expect(revokedResults.some((memory) => memory.memoryId === created.memory.memoryId)).toBe(false);

    await repository.setMemoryStatus({
      tenantId,
      memoryId: created.memory.memoryId,
      status: "active",
      actor: "quality-lead",
      sessionId: "lifecycle-c",
      idempotencyKey: `test-restore-${randomUUID()}`,
      reason: "Replacement evidence revalidated the memory.",
    });
    const restoredResults = await repository.retrieveMemories(tenantId, query, 30);
    expect(restoredResults.some((memory) => memory.memoryId === created.memory.memoryId)).toBe(true);
    const timeline = await repository.timeline(tenantId, created.incident.incidentId);
    expect(timeline.map((event) => event.eventType)).toContain("memory.revoked");
    expect(timeline.map((event) => event.eventType)).toContain("memory.restored");
  });

  it("publishes stable receipts through the transactional outbox", async () => {
    const publisher = new ReceiptPublisher(repository, { region: config.awsRegion });
    const result = await publisher.flush(tenantId);
    expect(result.failed).toBe(0);
    expect(result.published).toBeGreaterThan(0);
    const evidence = await repository.evidence(tenantId);
    expect(evidence.pendingReceipts).toBe(0);
    expect(evidence.publishedReceipts).toBeGreaterThan(0);
  });

  it("bounds Bedrock reasoning to reversible proposed actions and records provenance", async () => {
    const bedrockEngine = new DecisionEngine(repository, {
      reason: async () => ({
        synopsis: "Protect the customer promise while requesting timestamped carrier evidence.",
        actions: [{
          actionType: "request_carrier_checkpoint",
          title: "Request carrier checkpoint evidence",
          rationale: "A timestamped checkpoint verifies the delay before a human approves any routing change.",
          risk: "low",
          reversible: true,
        }],
        provider: "amazon-bedrock",
        modelId: "test-model",
      }),
    });
    const created = await bedrockEngine.process({
      tenantId,
      supplier: "HarborLine Logistics",
      shipmentRef: "BEDROCK-BOUNDARY-1",
      category: "delay",
      severity: 3,
      summary: "A carrier checkpoint is missing and the arrival estimate is now uncertain.",
      sessionId: "bedrock-boundary-session",
      actor: "judge-operator",
    }, `test-bedrock-${randomUUID()}`);
    expect(created.actions).toHaveLength(1);
    expect(created.actions[0]).toMatchObject({
      actionType: "request_carrier_checkpoint",
      state: "proposed",
      reversible: true,
    });
    expect(created.memory.provenance).toMatchObject({
      reasoningProvider: "amazon-bedrock",
      reasoningModelId: "test-model",
      humanApprovalRequired: true,
    });
  });

  it("passes the live operational memory evaluation without leaking evaluation tenants", async () => {
    const evaluation = await runSafetyEvaluation(repository);
    expect(evaluation.total).toBe(10);
    expect(evaluation.passed).toBe(evaluation.total);
    expect(evaluation.vectorIndex).toBe("memory_semantic_idx:cosine-vector-search");
    expect(evaluation.cleanupVerified).toBe(true);
    expect(evaluation.remainingRowsAfterCleanup).toBe(0);
    expect(evaluation.checks.every((check) => check.passed)).toBe(true);
  }, 90_000);
});
