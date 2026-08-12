import { describe, expect, it, vi } from "vitest";
import {
  managedMcpReadOnlyTools,
  requiredMcpAuditTools,
  runMcpAudit,
  type McpCaller,
  type McpToolDefinition,
} from "../src/mcpAudit.js";

describe("Managed MCP audit boundary", () => {
  it("calls only the allowlisted read-only tools and never exposes credentials", async () => {
    const calledToolNames: string[] = [];
    const callTool: McpCaller["callTool"] = vi.fn(async (request) => {
      calledToolNames.push(request.name);
      const evidence: Record<string, string> = {
        list_databases: "database_name: recallops",
        list_tables: "table_name: memory_records",
        get_table_schema: "columns: tenant_id, status, embedding",
        select_query: "memory_count: 3",
        explain_query: "vector search using memory_semantic_idx",
      };
      return { content: [{ type: "text", text: evidence[request.name] ?? "read-only result" }] };
    });
    const close = vi.fn(async () => undefined);
    const tools = managedMcpReadOnlyTools.map<McpToolDefinition>((name) => {
      if (name === "get_cluster") {
        return { name, inputSchema: { properties: { cluster_id: {} } } } as McpToolDefinition;
      }
      if (name === "explain_query") {
        return {
          name,
          inputSchema: {
            properties: { database_name: {}, query: {} },
            required: ["database_name", "query"],
          },
        } as McpToolDefinition;
      }
      return { name, inputSchema: {} } as McpToolDefinition;
    });
    tools.push(
      {
        name: "get_table_schema_duplicate_not_allowlisted",
        inputSchema: {
          properties: { database_name: {}, schema_name: {}, table_name: {} },
          required: ["database_name", "table_name"],
        },
      },
      { name: "delete_cluster", inputSchema: { properties: { cluster_id: {} } } },
    );
    const fakeCaller: McpCaller = {
      listTools: async () => ({ tools }),
      callTool,
      close,
    };
    const result = await runMcpAudit({
      serverUrl: "https://cockroachlabs.cloud/mcp",
      clusterId: "cluster-secret-123456",
      apiKey: "super-secret-api-key",
      callerFactory: async () => fakeCaller,
    });

    expect(callTool).toHaveBeenCalledTimes(managedMcpReadOnlyTools.length);
    expect(calledToolNames).toEqual(managedMcpReadOnlyTools);
    expect(managedMcpReadOnlyTools).not.toContain("delete_cluster");
    expect(managedMcpReadOnlyTools).not.toContain("show_statement");
    expect(requiredMcpAuditTools).toContain("explain_query");
    expect(JSON.stringify(result)).not.toContain("super-secret-api-key");
    expect(result.clusterIdSuffix).toBe("123456");
    expect(result.verified).toBe(true);
    expect(result.failedRequiredTools).toEqual([]);
    expect(close).toHaveBeenCalledOnce();
  });

  it("fails closed when a required argument cannot be mapped", async () => {
    let callCount = 0;
    const callTool: McpCaller["callTool"] = vi.fn(async () => {
      callCount += 1;
      return { content: [] };
    });
    const fakeCaller: McpCaller = {
      listTools: async () => ({
        tools: [{ name: "select_query", inputSchema: { properties: { account_id: {} }, required: ["account_id"] } }],
      }),
      callTool,
      close: async () => undefined,
    };
    const result = await runMcpAudit({
      serverUrl: "https://cockroachlabs.cloud/mcp",
      clusterId: "cluster-abcdef",
      apiKey: "secret",
      callerFactory: async () => fakeCaller,
    });
    expect(callCount).toBe(0);
    expect(result.checks.find((check) => check.tool === "select_query")?.status).toBe("failed");
    expect(result.verified).toBe(false);
    expect(result.failedRequiredTools).toContain("select_query");
  });

  it("treats a resolved MCP isError response as a failed required check", async () => {
    const fakeCaller: McpCaller = {
      listTools: async () => ({ tools: [{ name: "select_query", inputSchema: {} }] }),
      callTool: async () => ({ isError: true, content: [{ type: "text", text: "permission denied" }] }),
      close: async () => undefined,
    };
    const result = await runMcpAudit({
      serverUrl: "https://cockroachlabs.cloud/mcp",
      clusterId: "cluster-abcdef",
      apiKey: "secret",
      callerFactory: async () => fakeCaller,
    });
    expect(result.checks.find((check) => check.tool === "select_query")).toMatchObject({
      status: "failed",
      summary: "MCP tool returned isError=true.",
    });
    expect(result.verified).toBe(false);
    expect(result.failedRequiredTools).toContain("select_query");
  });
});
