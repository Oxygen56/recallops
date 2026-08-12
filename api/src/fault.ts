import type { DecisionEngine } from "./engine.js";
import type { DecisionBundle, IncidentCommand } from "./types.js";

export class InjectedAfterCommitError extends Error {
  constructor(readonly committedIncidentId: string) {
    super("simulated response loss after commit");
    this.name = "InjectedAfterCommitError";
  }
}

export async function processIncidentCommand(
  engine: DecisionEngine,
  command: IncidentCommand,
  idempotencyKey: string,
  injectAfterCommit = false,
): Promise<DecisionBundle> {
  const bundle = await engine.process(command, idempotencyKey);
  if (injectAfterCommit && !bundle.idempotentReplay) {
    throw new InjectedAfterCommitError(bundle.incident.incidentId);
  }
  return bundle;
}
