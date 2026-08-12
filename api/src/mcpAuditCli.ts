import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { canonicalJson } from "./hash.js";
import { runMcpAudit } from "./mcpAudit.js";

const config = loadConfig();
const result = await runMcpAudit({
  serverUrl: config.mcpServerUrl,
  clusterId: config.mcpClusterId ?? "",
  apiKey: config.mcpApiKey ?? "",
});
const receipt = {
  ...result,
  sourceCommit: process.env.SOURCE_COMMIT || undefined,
  sourceTree: process.env.SOURCE_TREE || undefined,
};
const outputDirectory = resolve(process.cwd(), "../artifacts/evidence");
const target = resolve(outputDirectory, "mcp-audit.json");
await mkdir(outputDirectory, { recursive: true });
await writeFile(target, `${canonicalJson(receipt)}\n`, "utf8");
console.log(JSON.stringify({
  target,
  verified: result.verified,
  failedRequiredTools: result.failedRequiredTools,
}, null, 2));
if (!result.verified) process.exitCode = 1;
