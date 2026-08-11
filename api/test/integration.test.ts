import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { seedDemo } from "../src/demoData.js";
import { deterministicEmbedding } from "../src/embedding.js";
import { DecisionEngine } from "../src/engine.js";
import { CockroachRepository, StaleRevisionError } from "../src/repository.js";
import { ReceiptPublisher } from "../src/receipts.js";

const config = loadConfig();
const repository = new CockroachRepository(config.databaseUrl);
const engine = new DecisionEngine(repository);
const tenantId = config.demoTenantId;

describe("CockroachDB incident memory integration", () => {
  beforeAll(async () => {
    await repository.health();
    await repository.resetDemoTenant(tenantId);
    await seedDemo(repository, tenantId);
  });

  afterAll(async () => {
    await repository.close();
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
    await repository.setMemoryStatus({
      tenantId,
      memoryId: created.memory.memoryId,
      status: "revoked",
      actor: "quality-lead",
      sessionId: "lifecycle-b",
      idempotencyKey: `test-revoke-${randomUUID()}`,
      reason: "Source evidence was superseded.",
    });
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
});
