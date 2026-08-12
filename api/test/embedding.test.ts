import { describe, expect, it } from "vitest";
import { deterministicEmbedding, vectorLiteral } from "../src/embedding.js";
import { canonicalJson, eventHash } from "../src/hash.js";

describe("deterministic evidence primitives", () => {
  it("produces stable normalized embeddings", () => {
    const first = deterministicEmbedding("port delay carrier milestone");
    const second = deterministicEmbedding("port delay carrier milestone");
    expect(first).toEqual(second);
    expect(first).toHaveLength(64);
    const norm = Math.sqrt(first.reduce((sum, value) => sum + value * value, 0));
    expect(norm).toBeCloseTo(1, 6);
    expect(vectorLiteral(first)).toMatch(/^\[[\d.,-]+\]$/);
  });

  it("canonicalizes object key order before hashing", () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 4 }, b: 2 }),
    );
    const base = {
      tenantId: "demo",
      aggregateId: "abc",
      version: 1,
      eventType: "incident.created",
      previousHash: "0".repeat(64),
      actor: "operator-a",
      sessionId: "session-a",
      idempotencyKey: "key-a",
    };
    expect(eventHash({ ...base, payload: { b: 2, a: 1 } })).toBe(
      eventHash({ ...base, payload: { a: 1, b: 2 } }),
    );
  });
});
