import { deterministicEmbedding } from "./embedding.js";
import { CockroachRepository } from "./repository.js";

const memories = [
  {
    kind: "resolved-incident",
    content:
      "Port congestion delayed shipment NX-104 by six days. A premature reroute added cost without improving arrival. The winning response held release, verified the carrier milestone, then used the original lane.",
    provenance: { source: "synthetic resolved incident", outcome: "avoid premature reroute", confidence: 0.92 },
  },
  {
    kind: "resolved-incident",
    content:
      "Supplier Atlas Components reported a coating defect on lot AC-77. Quarantine plus certificate review isolated one batch; switching the full supplier would have disrupted three healthy orders.",
    provenance: { source: "synthetic resolved incident", outcome: "quarantine one lot", confidence: 0.95 },
  },
  {
    kind: "policy",
    content:
      "Any compliance incident requires a chain-of-custody document set and human release approval. Agent recommendations cannot release a compliance hold automatically.",
    provenance: { source: "synthetic operating policy", owner: "demo compliance lead", confidence: 1 },
  },
];

export async function seedDemo(repository: CockroachRepository, tenantId = "demo-logistics"): Promise<void> {
  for (const item of memories) {
    await repository.seedMemory({
      tenantId,
      kind: item.kind,
      content: item.content,
      embedding: deterministicEmbedding(item.content),
      provenance: {
        ...item.provenance,
        schema: "recallops.memory-provenance.v1",
        embeddingProvider: "deterministic-sha256-feature-hash-v1",
        synthetic: true,
      },
    });
  }
}
