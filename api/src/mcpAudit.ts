import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const READ_ONLY_TOOLS = new Set([
  "list_clusters",
  "get_cluster",
  "list_databases",
  "list_tables",
  "get_table_schema",
  "select_query",
  "explain_query",
  "show_running_queries",
]);

const REQUIRED_AUDIT_TOOLS = new Set([
  "list_databases",
  "list_tables",
  "get_table_schema",
  "select_query",
  "explain_query",
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
  tenantId?: string;
  callerFactory?: () => Promise<McpCaller>;
}

export interface McpAuditResult {
  server: string;
  clusterIdSuffix: string;
  database: string;
  table: string;
  mode: "client-enforced-read-only-allowlist";
  availableReadOnlyTools: string[];
  requiredReadOnlyTools: string[];
  failedRequiredTools: string[];
  verified: boolean;
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

function safeIdentifier(value: string, label: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value)) {
    throw new Error(`Unsafe ${label} identifier.`);
  }
  return value;
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function argsFor(
  tool: McpToolDefinition,
  database: string,
  table: string,
  tenantId: string,
): Record<string, unknown> {
  const vector = `[1,${Array.from({ length: 63 }, () => "0").join(",")}]`;
  const selectSql = `SELECT count(*) AS memory_count FROM ${table}`;
  const explainSql = `SELECT tenant_id, memory_id FROM ${table}@memory_semantic_idx WHERE tenant_id = ${sqlLiteral(tenantId)} AND status = 'active' ORDER BY embedding <=> '${vector}'::VECTOR LIMIT 4`;
  const query = tool.name === "explain_query" ? explainSql : selectSql;
  const values = new Map<string, unknown>([
    ["database", database],
    ["databasename", database],
    ["dbname", database],
    ["schema", "public"],
    ["schemaname", "public"],
    ["table", table],
    ["tablename", table],
    ["statement", query],
    ["sql", query],
    ["query", query],
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

function summarizeResult(
  toolName: string,
  value: unknown,
  database: string,
  table: string,
): string {
  if (!value || typeof value !== "object") {
    throw new Error("MCP tool returned an invalid response envelope.");
  }
  if ((value as { isError?: boolean }).isError === true) {
    throw new Error("MCP tool returned isError=true.");
  }
  const json = JSON.stringify(value);
  if (!json || json === "{}") throw new Error("MCP tool returned an empty response.");
  const normalized = json.toLowerCase();
  const bytes = Buffer.byteLength(json, "utf8");
  if (toolName === "list_databases") {
    if (!normalized.includes(database.toLowerCase())) throw new Error(`Database ${database} was not present in the response.`);
    return `Database ${database} is present (${bytes} response bytes).`;
  }
  if (toolName === "list_tables") {
    if (!normalized.includes(table.toLowerCase())) throw new Error(`Table ${table} was not present in the response.`);
    return `Table ${table} is present (${bytes} response bytes).`;
  }
  if (toolName === "get_table_schema") {
    const requiredColumns = ["tenant_id", "status", "embedding"];
    const missing = requiredColumns.filter((column) => !normalized.includes(column));
    if (missing.length > 0) throw new Error(`Schema response omitted required columns: ${missing.join(", ")}.`);
    return `Schema exposes tenant_id, status, and embedding (${bytes} response bytes).`;
  }
  if (toolName === "select_query") {
    if (!/memory_count[^0-9]{0,240}[0-9]+/i.test(json)) {
      throw new Error("Count query response did not contain a numeric memory_count result.");
    }
    return `Read-only memory_count query returned a numeric result (${bytes} response bytes).`;
  }
  if (toolName === "explain_query") {
    if (!normalized.includes("memory_semantic_idx") || !/vector[\s_-]*search/i.test(json)) {
      throw new Error("EXPLAIN response did not prove a vector search using memory_semantic_idx.");
    }
    return `EXPLAIN proves vector search via memory_semantic_idx (${bytes} response bytes).`;
  }
  return `Non-empty read-only response received (${bytes} bytes).`;
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
  const tenantId = options.tenantId ?? "demo-logistics";
  safeIdentifier(database, "database");
  safeIdentifier(table, "table");
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
        const response = await caller.callTool({
          name: tool.name,
          arguments: argsFor(tool, database, table, tenantId),
        });
        checks.push({
          tool: tool.name,
          status: "verified",
          summary: summarizeResult(tool.name, response, database, table),
        });
      } catch (error) {
        checks.push({
          tool: tool.name,
          status: "failed",
          summary: error instanceof Error ? error.message.slice(0, 240) : "Unknown MCP error",
        });
      }
    }
    const failedRequiredTools = checks
      .filter((check) => REQUIRED_AUDIT_TOOLS.has(check.tool) && check.status !== "verified")
      .map((check) => check.tool);
    return {
      server: new URL(options.serverUrl).origin,
      clusterIdSuffix: options.clusterId.slice(-6),
      database,
      table,
      mode: "client-enforced-read-only-allowlist",
      availableReadOnlyTools: available.map((tool) => tool.name),
      requiredReadOnlyTools: [...REQUIRED_AUDIT_TOOLS],
      failedRequiredTools,
      verified: failedRequiredTools.length === 0,
      checks,
      verifiedAt: new Date().toISOString(),
    };
  } finally {
    await caller.close();
  }
}

export const managedMcpReadOnlyTools = [...READ_ONLY_TOOLS];
export const requiredMcpAuditTools = [...REQUIRED_AUDIT_TOOLS];
