import { createHash } from "node:crypto";

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stable(nested)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(stable(value));
}

export function requestHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function eventHash(input: {
  tenantId: string;
  aggregateId: string;
  version: number;
  eventType: string;
  payload: Record<string, unknown>;
  previousHash: string;
  actor: string;
  sessionId: string;
  idempotencyKey: string;
}): string {
  return requestHash(input);
}
