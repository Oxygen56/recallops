import { deterministicEmbedding } from "./embedding.js";
import { CockroachRepository } from "./repository.js";
import type { DecisionReasoner } from "./reasoner.js";
import type { DecisionBundle, DecisionDraft, IncidentCommand, MemoryRecord } from "./types.js";

const PLAYBOOKS = {
  delay: {
    synopsis: "Protect the customer promise while evidence is collected and a reversible reroute is evaluated.",
    actions: [
      {
        actionType: "hold_release",
        title: "Place a reversible release hold",
        rationale: "Prevents downstream promises from being made against an uncertain arrival time.",
        risk: "low" as const,
        reversible: true,
      },
      {
        actionType: "request_carrier_evidence",
        title: "Request carrier milestone evidence",
        rationale: "Converts an unverified delay report into timestamped operational evidence.",
        risk: "low" as const,
        reversible: true,
      },
      {
        actionType: "evaluate_reroute",
        title: "Evaluate alternate port and lane",
        rationale: "A reroute is proposed only after similar incident outcomes are reviewed.",
        risk: "medium" as const,
        reversible: true,
      },
    ],
  },
  quality: {
    synopsis: "Contain the affected lot, preserve evidence, and use prior supplier outcomes before release.",
    actions: [
      {
        actionType: "quarantine_lot",
        title: "Quarantine the affected lot",
        rationale: "Stops suspect material from entering production while preserving reversibility.",
        risk: "low" as const,
        reversible: true,
      },
      {
        actionType: "request_quality_evidence",
        title: "Request certificate and inspection evidence",
        rationale: "Requires source evidence before any quality memory can influence future decisions.",
        risk: "low" as const,
        reversible: true,
      },
      {
        actionType: "evaluate_alternate_supplier",
        title: "Evaluate an approved alternate supplier",
        rationale: "Uses prior resolution outcomes without automatically switching supply.",
        risk: "medium" as const,
        reversible: true,
      },
    ],
  },
  capacity: {
    synopsis: "Reduce single-supplier exposure through bounded allocation changes and explicit approval.",
    actions: [
      {
        actionType: "reserve_buffer",
        title: "Reserve available safety stock",
        rationale: "Protects near-term demand while the capacity claim is verified.",
        risk: "low" as const,
        reversible: true,
      },
      {
        actionType: "split_order",
        title: "Propose a split order",
        rationale: "Limits concentration risk without silently creating a new purchase commitment.",
        risk: "medium" as const,
        reversible: true,
      },
    ],
  },
  compliance: {
    synopsis: "Stop movement, capture provenance, and require human clearance before release.",
    actions: [
      {
        actionType: "compliance_hold",
        title: "Apply a compliance hold",
        rationale: "Prevents a potentially non-compliant shipment from progressing.",
        risk: "low" as const,
        reversible: true,
      },
      {
        actionType: "collect_chain_of_custody",
        title: "Collect chain-of-custody documents",
        rationale: "Creates an auditable evidence package for a human compliance decision.",
        risk: "low" as const,
        reversible: true,
      },
    ],
  },
};

function summarizeSimilar(memories: MemoryRecord[]): string {
  if (memories.length === 0) return "No prior active memory was similar enough to cite.";
  return memories
    .slice(0, 3)
    .map((memory, index) => `${index + 1}. ${memory.content} [memory:${memory.memoryId}]`)
    .join("\n");
}

export class DecisionEngine {
  constructor(
    private readonly repository: CockroachRepository,
    private readonly reasoner?: DecisionReasoner,
  ) {}

  async process(command: IncidentCommand, idempotencyKey: string): Promise<DecisionBundle> {
    const replay = await this.repository.replayIncident(command, idempotencyKey);
    if (replay) return replay;
    const embeddingText = `${command.category} ${command.supplier} ${command.summary}`;
    const embedding = deterministicEmbedding(embeddingText);
    const similarMemories = await this.repository.retrieveMemories(command.tenantId, embedding, 4);
    const playbook = PLAYBOOKS[command.category];
    let reasoning: Awaited<ReturnType<DecisionReasoner["reason"]>> | undefined;
    let reasoningFallback: string | undefined;
    if (this.reasoner) {
      try {
        reasoning = await this.reasoner.reason(command, similarMemories);
      } catch (error) {
        reasoningFallback = error instanceof Error ? error.message.slice(0, 180) : "unknown model failure";
      }
    }
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 45 * 24 * 60 * 60 * 1000).toISOString();
    const memoryContent = [
      `Incident ${command.shipmentRef}: ${command.summary}`,
      `Category ${command.category}; severity ${command.severity}; supplier ${command.supplier}.`,
      `Decision posture: ${reasoning?.synopsis ?? playbook.synopsis}`,
      `Relevant prior outcomes:\n${summarizeSimilar(similarMemories)}`,
    ].join("\n");

    const draft: DecisionDraft = {
      synopsis: reasoning?.synopsis ?? playbook.synopsis,
      memoryContent,
      memoryKind: "incident-decision",
      expiresAt,
      provenance: {
        schema: "recallops.memory-provenance.v1",
        source: "operator incident command",
        sourceShipmentRef: command.shipmentRef,
        sourceSessionId: command.sessionId,
        embeddingProvider: "deterministic-sha256-feature-hash-v1",
        embeddingDimensions: 64,
        admittedAt: now.toISOString(),
        similarMemoryIds: similarMemories.map((memory) => memory.memoryId),
        humanApprovalRequired: true,
        reasoningProvider: reasoning?.provider ?? "deterministic-safety-playbook-v1",
        reasoningModelId: reasoning?.modelId ?? null,
        reasoningFallback: reasoningFallback ?? null,
      },
      similarMemories,
      actions: reasoning?.actions ?? playbook.actions,
    };
    return this.repository.createIncident(command, idempotencyKey, embedding, draft);
  }
}
