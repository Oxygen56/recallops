import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { canonicalJson } from "./hash.js";

const config = loadConfig();
const { app, repository } = createApp(config);
const tenantId = config.demoTenantId;
const scenarioId = randomUUID();
const incidentKey = `demo-ambiguous-${scenarioId}`;
const command = {
  tenantId,
  supplier: "HarborLine Logistics",
  shipmentRef: "HL-DEMO-2048",
  category: "delay",
  severity: 4,
  summary: "Carrier milestone is missing after six days of port congestion; customer promise is at risk.",
  sessionId: "night-shift-session",
  actor: "night-shift-operator",
};

try {
  await app.request("/v1/demo/reset", { method: "POST" });
  const lostResponse = await app.request("/v1/incidents", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": incidentKey,
      "x-recallops-fault": "after-commit",
    },
    body: JSON.stringify(command),
  });
  const lostPayload = await lostResponse.json();
  const reconciledResponse = await app.request("/v1/incidents", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": incidentKey },
    body: JSON.stringify(command),
  });
  const reconciled = await reconciledResponse.json() as any;
  const action = reconciled.actions[0];
  const approveResponse = await app.request(`/v1/actions/${action.actionId}/approve`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": `demo-approve-${scenarioId}`,
    },
    body: JSON.stringify({
      tenantId,
      expectedRevision: action.revision,
      actor: "morning-shift-lead",
      sessionId: "morning-shift-session",
    }),
  });
  const approved = await approveResponse.json();
  const followUpResponse = await app.request("/v1/incidents", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": `demo-cross-session-${scenarioId}`,
    },
    body: JSON.stringify({
      ...command,
      shipmentRef: "HL-DEMO-2051",
      summary: "A second port delay repeats the missing carrier milestone pattern from the prior shift.",
      sessionId: "morning-shift-session",
      actor: "morning-shift-lead",
    }),
  });
  const followUp = await followUpResponse.json() as any;
  const flushResponse = await app.request("/v1/evidence/flush", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tenantId }),
  });
  const flush = await flushResponse.json();
  const evidenceResponse = await app.request(`/v1/evidence?tenantId=${tenantId}`);
  const evidence = await evidenceResponse.json();
  const timelineResponse = await app.request(
    `/v1/incidents/${reconciled.incident.incidentId}/timeline?tenantId=${tenantId}`,
  );
  const timeline = await timelineResponse.json();

  const receipt = {
    schema: "recallops.local-demo-evidence.v1",
    generatedAt: new Date().toISOString(),
    scenarioId,
    assertions: {
      faultReturned503: lostResponse.status === 503,
      commitWasReconciled: reconciled.idempotentReplay === true,
      sameIncidentRecovered:
        lostPayload.committedIncidentId === reconciled.incident.incidentId,
      actionApprovedInNewSession: approved.action?.state === "approved",
      crossSessionMemoryFound: followUp.similarMemories?.some(
        (memory: any) => memory.memoryId === reconciled.memory.memoryId,
      ) === true,
      vectorIndexActive: evidence.vectorIndex === "memory_semantic_idx:active",
      receiptsPublished: flush.failed === 0 && flush.published > 0,
    },
    identifiers: {
      committedIncidentId: reconciled.incident.incidentId,
      recoveredMemoryId: reconciled.memory.memoryId,
      approvedActionId: approved.action?.actionId,
    },
    evidence,
    timelineHashes: timeline.events?.map((event: any) => ({
      version: event.version,
      eventType: event.eventType,
      previousHash: event.previousHash,
      eventHash: event.eventHash,
    })),
  };
  const outputDirectory = resolve(process.cwd(), "../artifacts/evidence");
  await mkdir(outputDirectory, { recursive: true });
  const target = resolve(outputDirectory, "local-demo.json");
  await writeFile(target, `${canonicalJson(receipt)}\n`, "utf8");
  console.log(JSON.stringify({ target, ...receipt.assertions }, null, 2));
  if (Object.values(receipt.assertions).some((value) => value !== true)) process.exitCode = 1;
} finally {
  await repository.close();
}
