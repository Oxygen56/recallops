export type IncidentCategory = "delay" | "quality" | "capacity" | "compliance";

export interface IncidentCommand {
  tenantId: string;
  supplier: string;
  shipmentRef: string;
  category: IncidentCategory;
  severity: number;
  summary: string;
  sessionId: string;
  actor: string;
}

export interface Incident {
  tenantId: string;
  incidentId: string;
  supplier: string;
  shipmentRef: string;
  category: IncidentCategory;
  severity: number;
  summary: string;
  status: string;
  sessionId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryRecord {
  tenantId: string;
  memoryId: string;
  incidentId: string | null;
  kind: string;
  content: string;
  provenance: Record<string, unknown>;
  status: "active" | "revoked";
  expiresAt: string | null;
  revision: number;
  score?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ActionProposal {
  tenantId: string;
  actionId: string;
  incidentId: string;
  actionType: string;
  title: string;
  rationale: string;
  risk: "low" | "medium" | "high";
  reversible: boolean;
  state: "proposed" | "approved" | "executed" | "compensated" | "rejected";
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface DecisionDraft {
  synopsis: string;
  memoryContent: string;
  memoryKind: string;
  expiresAt: string | null;
  provenance: Record<string, unknown>;
  similarMemories: MemoryRecord[];
  actions: Array<Omit<ActionProposal, "tenantId" | "actionId" | "incidentId" | "state" | "revision" | "createdAt" | "updatedAt">>;
}

export interface DecisionBundle {
  incident: Incident;
  memory: MemoryRecord;
  actions: ActionProposal[];
  similarMemories: MemoryRecord[];
  idempotentReplay: boolean;
  receiptState: "pending" | "published" | "failed";
}

export interface TimelineEvent {
  eventId: string;
  aggregateId: string;
  version: number;
  eventType: string;
  payload: Record<string, unknown>;
  actor: string;
  sessionId: string;
  idempotencyKey: string;
  previousHash: string;
  eventHash: string;
  createdAt: string;
}

export interface EvidenceSummary {
  tenantId: string;
  incidents: number;
  activeMemories: number;
  revokedMemories: number;
  events: number;
  pendingReceipts: number;
  publishedReceipts: number;
  vectorIndex: string;
  databaseVersion: string;
}
