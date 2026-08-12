import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { canonicalJson } from "./hash.js";
import { CockroachRepository } from "./repository.js";
import { runSafetyEvaluation } from "./safetyEval.js";

const config = loadConfig();
const repository = new CockroachRepository(config.databaseUrl);

try {
  const evaluation = await runSafetyEvaluation(repository);
  const receipt = {
    ...evaluation,
    sourceCommit: process.env.SOURCE_COMMIT || undefined,
    sourceTree: process.env.SOURCE_TREE || undefined,
  };
  const outputDirectory = resolve(process.cwd(), "../artifacts/evidence");
  const target = resolve(outputDirectory, "safety-evaluation.json");
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(target, `${canonicalJson(receipt)}\n`, "utf8");
  console.log(JSON.stringify({
    target,
    passed: evaluation.passed,
    total: evaluation.total,
    runtimeMs: evaluation.runtimeMs,
  }, null, 2));
  if (
    evaluation.passed !== evaluation.total ||
    !evaluation.cleanupVerified ||
    evaluation.remainingRowsAfterCleanup !== 0
  ) {
    process.exitCode = 1;
  }
} finally {
  await repository.close();
}
