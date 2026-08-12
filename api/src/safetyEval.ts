import { randomUUID } from "node:crypto";
import { deterministicEmbedding } from "./embedding.js";
import { DecisionEngine } from "./engine.js";
import { InjectedAfterCommitError, processIncidentCommand } from "./fault.js";
import { eventHash } from "./hash.js";
import { CockroachRepository, StaleRevisionError } from "./repository.js";

export interface SafetyCheck {
  id: string;
  label: string;
  passed: boolean;
  proof: string;
}

export interface SafetyEvaluation {
  schema: "recallops.safety-evaluation.v1";
  evaluationId: string;
  generatedAt: string;
  runtimeMs: number;
  passed: number;
  total: number;
  databaseVersion: string;
  vectorIndex: string;
  cleanupVerified: boolean;
  remainingRowsAfterCleanup: number;
  checks: SafetyCheck[];
}

const ZERO_HASH = "0".repeat(64);

export async function runSafetyEvaluation(
  repository: CockroachRepository,
): Promise<SafetyEvaluation> {
  const evaluationId = randomUUID();
  const tenantId = `eval-${evaluationId}`;
  const shadowTenantId = `${tenantId}-shadow`;
  const evaluationTenants = [tenantId, shadowTenantId];
  const engine = new DecisionEngine(repository);
  const startedAt = Date.now();
  const checks: SafetyCheck[] = [];
  let result: Omit<SafetyEvaluation, "cleanupVerified" | "remainingRowsAfterCleanup"> | undefined;
  let executionError: unknown;
  const record = (id: string, label: string, passed: boolean, proof: string) => {
    checks.push({ id, label, passed, proof });
  };

  try {
    await repository.deleteStaleEvaluationTenants(15);
    const command = {
      tenantId,
      supplier: "HarborLine Logistics",
      shipmentRef: `EVAL-${evaluationId.slice(0, 8)}`,
      category: "delay" as const,
      severity: 4,
      summary: "Carrier milestone is missing after a six-day port congestion delay.",
      sessionId: "eval-night-shift",
      actor: "eval-operator-a",
    };
    const incidentKey = `eval-incident-${evaluationId}`;
    let committedIncidentId: string | undefined;
    let lossInjected = false;
    try {
      await processIncidentCommand(engine, command, incidentKey, true);
    } catch (error) {
      if (!(error instanceof InjectedAfterCommitError)) throw error;
      committedIncidentId = error.committedIncidentId;
      lossInjected = true;
    }
    const recovered = await processIncidentCommand(engine, command, incidentKey);
    record(
      "ambiguous-commit",
      "Injected lost-result recovery",
      lossInjected && recovered.idempotentReplay && recovered.incident.incidentId === committedIncidentId,
      `fault=${lossInjected}; replay=${recovered.idempotentReplay}; incident=${recovered.incident.incidentId.slice(0, 8)}`,
    );

    const aggregate = await repository.aggregateEvidence(tenantId, recovered.incident.incidentId);
    record(
      "zero-duplicates",
      "Replay creates zero duplicate rows",
      aggregate.incidents === 1 && aggregate.memories === 1 &&
        aggregate.actions === recovered.actions.length && aggregate.createdEvents === 1,
      `incidents=${aggregate.incidents}; memories=${aggregate.memories}; actions=${aggregate.actions}; create-events=${aggregate.createdEvents}`,
    );

    const candidate = recovered.actions[0];
    const concurrent = await Promise.allSettled(
      ["a", "b"].map((suffix) => repository.transitionAction({
        tenantId,
        actionId: candidate.actionId,
        expectedRevision: candidate.revision,
        targetState: "approved",
        actor: `eval-reviewer-${suffix}`,
        sessionId: `eval-concurrent-${suffix}`,
        idempotencyKey: `eval-approve-${suffix}-${evaluationId}`,
      })),
    );
    const winners = concurrent.filter((attempt) => attempt.status === "fulfilled");
    const losers = concurrent.filter((attempt) => attempt.status === "rejected");
    const afterApproval = await repository.getIncident(tenantId, recovered.incident.incidentId);
    const finalCandidate = afterApproval.actions.find((action) => action.actionId === candidate.actionId);
    const afterApprovalCounts = await repository.aggregateEvidence(tenantId, recovered.incident.incidentId);
    const staleLoser = losers.length === 1 && losers[0].status === "rejected" &&
      losers[0].reason instanceof StaleRevisionError;
    record(
      "concurrent-approval",
      "Racing approvals have one revision winner",
      winners.length === 1 && staleLoser && finalCandidate?.state === "approved" &&
        finalCandidate.revision === 2 && afterApprovalCounts.approvedEvents === 1,
      `winners=${winners.length}; stale-losers=${staleLoser ? 1 : 0}; revision=${finalCandidate?.revision ?? "missing"}; approval-events=${afterApprovalCounts.approvedEvents}`,
    );

    const approved = winners[0]?.status === "fulfilled" ? winners[0].value : null;
    const [compensated, followUp] = await Promise.all([
      approved
        ? repository.transitionAction({
          tenantId,
          actionId: approved.actionId,
          expectedRevision: approved.revision,
          targetState: "compensated",
          actor: "eval-recovery-lead",
          sessionId: "eval-recovery-shift",
          idempotencyKey: `eval-compensate-${evaluationId}`,
        })
        : Promise.resolve(null),
      engine.process({
        ...command,
        shipmentRef: `${command.shipmentRef}-NEXT`,
        summary: "A new port delay repeats the missing carrier milestone pattern from the prior shift.",
        sessionId: "eval-morning-shift",
        actor: "eval-operator-b",
      }, `eval-cross-session-${evaluationId}`),
    ]);
    record(
      "compensation",
      "Approved proposal records a compensation",
      compensated?.state === "compensated" && compensated.revision === 3,
      `state=${compensated?.state ?? "missing"}; revision=${compensated?.revision ?? "missing"}`,
    );

    const recalledAcrossSessions = followUp.similarMemories.some(
      (memory) => memory.memoryId === recovered.memory.memoryId,
    );
    record(
      "cross-session",
      "A new shift recalls the prior decision",
      recalledAcrossSessions,
      `prior-memory=${recovered.memory.memoryId.slice(0, 8)}; recalled=${recalledAcrossSessions}`,
    );

    const query = deterministicEmbedding(`${command.category} ${command.supplier} ${command.summary}`);
    await repository.setMemoryStatus({
      tenantId,
      memoryId: recovered.memory.memoryId,
      status: "revoked",
      actor: "eval-governance",
      sessionId: "eval-governance-revoke",
      idempotencyKey: `eval-revoke-${evaluationId}`,
      reason: "Operational memory evaluation revocation check.",
    });
    const afterRevoke = await repository.retrieveMemories(tenantId, query, 30);
    await repository.setMemoryStatus({
      tenantId,
      memoryId: recovered.memory.memoryId,
      status: "active",
      actor: "eval-governance",
      sessionId: "eval-governance-restore",
      idempotencyKey: `eval-restore-${evaluationId}`,
      reason: "Operational memory evaluation restoration check.",
    });
    const afterRestore = await repository.retrieveMemories(tenantId, query, 30);
    const absentWhenRevoked = !afterRevoke.some((memory) => memory.memoryId === recovered.memory.memoryId);
    const presentWhenRestored = afterRestore.some((memory) => memory.memoryId === recovered.memory.memoryId);
    record(
      "memory-lifecycle",
      "Revocation and restoration change recall",
      absentWhenRevoked && presentWhenRestored,
      `revoked-match=${!absentWhenRevoked}; restored-match=${presentWhenRestored}`,
    );

    const [expired, shadow] = await Promise.all([
      repository.seedMemory({
        tenantId,
        kind: "expired-eval-sentinel",
        content: command.summary,
        embedding: query,
        provenance: { schema: "recallops.memory-provenance.v1", synthetic: true },
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      }),
      repository.seedMemory({
        tenantId: shadowTenantId,
        kind: "tenant-prefix-sentinel",
        content: command.summary,
        embedding: query,
        provenance: { schema: "recallops.memory-provenance.v1", synthetic: true },
      }),
    ]);
    const afterExpiry = await repository.retrieveMemories(tenantId, query, 50);
    const expiredFound = afterExpiry.some((memory) => memory.memoryId === expired.memoryId);
    record(
      "expiry",
      "Expired memory is excluded before TTL deletion",
      !expiredFound,
      `expired-sentinel-returned=${expiredFound}`,
    );

    const crossedPrefix = afterExpiry.some((memory) => memory.memoryId === shadow.memoryId);
    record(
      "tenant-prefix",
      "Tenant-prefix vector query excludes shadow rows",
      !crossedPrefix,
      `perfect-match-shadow-row-returned=${crossedPrefix}`,
    );

    const [timeline, index, evidence] = await Promise.all([
      repository.timeline(tenantId, recovered.incident.incidentId),
      repository.vectorIndexPlan(tenantId, query),
      repository.evidence(tenantId),
    ]);
    let previousHash = ZERO_HASH;
    const chainValid = timeline.every((event) => {
      const expected = eventHash({
        tenantId,
        aggregateId: event.aggregateId,
        version: event.version,
        eventType: event.eventType,
        payload: event.payload,
        previousHash,
        actor: event.actor,
        sessionId: event.sessionId,
        idempotencyKey: event.idempotencyKey,
      });
      const valid = event.previousHash === previousHash && event.eventHash === expected;
      previousHash = event.eventHash;
      return valid;
    });
    record(
      "hash-chain",
      "Payload and audit metadata hash chain recomputes",
      chainValid && timeline.length >= 5,
      `events=${timeline.length}; broken-links=${chainValid ? 0 : 1}`,
    );

    record(
      "vector-index",
      "Cosine query executes as a distributed vector search",
      index.usesVectorIndex && index.cosineOpclass,
      `vector-search=${index.usesVectorIndex}; cosine-opclass=${index.cosineOpclass}`,
    );

    result = {
      schema: "recallops.safety-evaluation.v1",
      evaluationId,
      generatedAt: new Date().toISOString(),
      runtimeMs: Date.now() - startedAt,
      passed: checks.filter((check) => check.passed).length,
      total: checks.length,
      databaseVersion: evidence.databaseVersion,
      vectorIndex: index.usesVectorIndex && index.cosineOpclass
        ? "memory_semantic_idx:cosine-vector-search"
        : "not-verified",
      checks,
    };
  } catch (error) {
    executionError = error;
  }

  const cleanupErrors: unknown[] = [];
  const cleanupResults = await Promise.allSettled([repository.deleteEvaluationTenants(evaluationTenants)]);
  cleanupResults.forEach((cleanup) => {
    if (cleanup.status === "rejected") cleanupErrors.push(cleanup.reason);
  });
  const remainingRowsAfterCleanup = await repository.evaluationRows(evaluationTenants).catch((error) => {
    cleanupErrors.push(error);
    return -1;
  });
  if (cleanupErrors.length > 0 || remainingRowsAfterCleanup !== 0) {
    throw new Error(`evaluation cleanup failed: errors=${cleanupErrors.length}; rows=${remainingRowsAfterCleanup}`);
  }
  if (executionError) throw executionError;
  if (!result) throw new Error("evaluation did not produce a result");
  return {
    ...result,
    cleanupVerified: true,
    remainingRowsAfterCleanup,
  };
}
