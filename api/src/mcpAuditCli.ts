import { loadConfig } from "./config.js";
import { runMcpAudit } from "./mcpAudit.js";

const config = loadConfig();
const result = await runMcpAudit({
  serverUrl: config.mcpServerUrl,
  clusterId: config.mcpClusterId ?? "",
  apiKey: config.mcpApiKey ?? "",
});
console.log(JSON.stringify(result, null, 2));
if (!result.verified) process.exitCode = 1;
