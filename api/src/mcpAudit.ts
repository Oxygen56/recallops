import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const READ_ONLY_TOOLS = new Set([
  "list_databases",
  "list_tables",
  "get_table_schema",
  "show_statement",
  "select_query",
]);

type JsonSchema = {
  properties?: Record<string, { type?: string }>;
  required?: string[];
};

export interface McpToolDefinition {
  name: string;
  inputSchema?: JsonSchema;
}

export interface McpCaller {
  listTools(): Promise<{ tools: McpToolDefinition[] }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
  close(): Promise<void>;
}

export interface McpAuditOptions {
  serverUrl: string;
  clusterId: string;
  apiKey: string;
  databaseName?: string;
  tableName?: string;
  callerFactory?: () => Promise<McpCaller>;
}

export interface McpAuditResult {
  server: string;
  clusterIdSuffix: string;
  database: string;
  table: string;
  mode: "read-only";
  availableReadOnlyTools: string[];
  checks: Array<{
    tool: string;
    status: "verified" | "unavailable" | "failed";
    summary: string;
  }>;
  verifiedAt: string;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function argsFor(tool: McpToolDefinition, database: string, table: string): Record<string, unknown> {
  const values = new Map<string, unknown>([
    ["database", database],
    ["databasename", database],
    ["dbname", database],
    ["schema", "public"],
    ["schemaname", "public"],
    ["table", table],
    ["tablename", table],
    ["statement", `SHOW INDEXES FROM ${table}`],
    ["sql", `SELECT count(*) AS memory_count FROM ${table}`],
    ["query", `SELECT count(*) AS memory_count FROM ${table}`],
  ]);
  const args: Record<string, unknown> = {};
  const required = new Set(tool.inputSchema?.required ?? []);
  for (const property of Object.keys(tool.inputSchema?.properties ?? {})) {
    const candidate = values.get(normalize(property));
    if (candidate !== undefined) args[property] = candidate;
    else if (required.has(property)) {
      throw new Error(`Unsupported required MCP argument: ${tool.name}.${property}`);
    }
  }
  return args;
}

function summarizeResult(value: unknown): string {
  const json = JSON.stringify(value);
  if (!json) return "Tool returned an empty response.";
  return `Read-only response received (${Buffer.byteLength(json, "utf8")} bytes).`;
}

async function createCaller(options: McpAuditOptions): Promise<McpCaller> {
  const client = new Client({ name: "recallops-mcp-audit", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(options.serverUrl), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "mcp-cluster-id": options.clusterId,
      },
    },
  });
  await client.connect(transport);
  return client;
}

export async function runMcpAudit(options: McpAuditOptions): Promise<McpAuditResult> {
  if (!options.clusterId || !options.apiKey) {
    throw new Error("Managed MCP requires MCP_CLUSTER_ID and MCP_SERVICE_ACCOUNT_API_KEY.");
  }
  const database = options.databaseName ?? "recallops";
  const table = options.tableName ?? "memory_records";
  const caller = options.callerFactory ? await options.callerFactory() : await createCaller(options);
  const checks: McpAuditResult["checks"] = [];
  try {
    const listed = await caller.listTools();
    const available = listed.tools.filter((tool) => READ_ONLY_TOOLS.has(tool.name));
    for (const toolName of READ_ONLY_TOOLS) {
      const tool = available.find((candidate) => candidate.name === toolName);
      if (!tool) {
        checks.push({ tool: toolName, status: "unavailable", summary: "Tool was not advertised by the server." });
        continue;
      }
      try {
        const response = await caller.callTool({ name: tool.name, arguments: argsFor(tool, database, table) });
        checks.push({ tool: tool.name, status: "verified", summary: summarizeResult(response) });
      } catch (error) {
        checks.push({
          tool: tool.name,
          status: "failed",
          summary: error instanceof Error ? error.message.slice(0, 240) : "Unknown MCP error",
        });
      }
    }
    return {
      server: new URL(options.serverUrl).origin,
      clusterIdSuffix: options.clusterId.slice(-6),
      database,
      table,
      mode: "read-only",
      availableReadOnlyTools: available.map((tool) => tool.name),
      checks,
      verifiedAt: new Date().toISOString(),
    };
  } finally {
    await caller.close();
  }
}

export const managedMcpReadOnlyTools = [...READ_ONLY_TOOLS];
