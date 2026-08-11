import { createHash } from "node:crypto";

export const EMBEDDING_DIMENSIONS = 64;

export function deterministicEmbedding(text: string, dimensions = EMBEDDING_DIMENSIONS): number[] {
  const vector = Array.from({ length: dimensions }, () => 0);
  const tokens = text
    .toLowerCase()
    .normalize("NFKC")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  for (const token of tokens) {
    const digest = createHash("sha256").update(token).digest();
    for (let offset = 0; offset < 16; offset += 4) {
      const bucket = digest.readUInt16BE(offset) % dimensions;
      const magnitude = 1 + digest[offset + 2] / 255;
      const sign = digest[offset + 3] % 2 === 0 ? 1 : -1;
      vector[bucket] += sign * magnitude;
    }
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) {
    vector[0] = 1;
    return vector;
  }
  return vector.map((value) => Number((value / norm).toFixed(8)));
}

export function vectorLiteral(vector: number[]): string {
  return `[${vector.map((value) => Number(value).toFixed(8)).join(",")}]`;
}
