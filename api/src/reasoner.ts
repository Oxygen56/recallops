import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { z } from "zod";
import type { IncidentCommand, MemoryRecord } from "./types.js";

const reasoningSchema = z.object({
  synopsis: z.string().min(20).max(500),
  actions: z.array(z.object({
    actionType: z.string().regex(/^[a-z0-9_]{3,64}$/),
    title: z.string().min(8).max(120),
    rationale: z.string().min(20).max(500),
    risk: z.enum(["low", "medium"]),
    reversible: z.literal(true),
  })).min(1).max(3),
});

export type SafeReasoning = z.infer<typeof reasoningSchema> & {
  provider: "amazon-bedrock";
  modelId: string;
};

export interface DecisionReasoner {
  reason(command: IncidentCommand, memories: MemoryRecord[]): Promise<SafeReasoning>;
}

function prompt(command: IncidentCommand, memories: MemoryRecord[]): string {
  const memoryContext = memories.slice(0, 4).map((memory) => ({
    memoryId: memory.memoryId,
    content: memory.content,
    provenance: memory.provenance,
  }));
  return [
    "You are a supply-chain incident decision assistant.",
    "Return JSON only with keys synopsis and actions.",
    "Every action must be reversible, require human approval, and have risk low or medium.",
    "Never claim an external action was executed. Propose at most three evidence-first actions.",
    `Incident: ${JSON.stringify(command)}`,
    `Retrieved active memories: ${JSON.stringify(memoryContext)}`,
    'Schema: {"synopsis":"string","actions":[{"actionType":"snake_case","title":"string","rationale":"string","risk":"low|medium","reversible":true}]}',
  ].join("\n");
}

function jsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Bedrock response did not contain a JSON object.");
  return JSON.parse(text.slice(start, end + 1));
}

export class BedrockDecisionReasoner implements DecisionReasoner {
  private readonly client: BedrockRuntimeClient;

  constructor(private readonly modelId: string, region: string) {
    this.client = new BedrockRuntimeClient({ region });
  }

  async reason(command: IncidentCommand, memories: MemoryRecord[]): Promise<SafeReasoning> {
    const response = await this.client.send(new ConverseCommand({
      modelId: this.modelId,
      messages: [{ role: "user", content: [{ text: prompt(command, memories) }] }],
      inferenceConfig: { maxTokens: 700, temperature: 0.1, topP: 0.9 },
    }));
    const text = response.output?.message?.content?.find((block) => "text" in block)?.text;
    if (!text) throw new Error("Bedrock response did not contain text.");
    return {
      ...reasoningSchema.parse(jsonObject(text)),
      provider: "amazon-bedrock",
      modelId: this.modelId,
    };
  }
}
