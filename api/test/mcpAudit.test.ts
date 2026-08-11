import { describe, expect, it, vi } from "vitest";
import {
  managedMcpReadOnlyTools,
  runMcpAudit,
  type McpCaller,
  type McpToolDefinition,
} from "../src/mcpAudit.js";

describe("Managed MCP audit boundary", () => {
  it("calls only the allowlisted read-only tools and never exposes credentials", async () => {
    const calledToolNames: string[] = [];
    const callTool: McpCaller["callTool"] = vi.fn(async (request) => {
      calledToolNames.push(request.name);
      return { content: [{ type: "text", text: "ok" }] };
    });
    const close = vi.fn(async () => undefined);
    const tools: McpToolDefinition[] = [
      { name: "list_databases", inputSchema: {} },
      {
        name: "get_table_schema",
        inputSchema: {
          properties: { database_name: {}, schema_name: {}, table_name: {} },
          required: ["database_name", "table_name"],
        },
      },
      { name: "delete_cluster", inputSchema: { properties: { cluster_id: {} } } },
    ];
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

    expect(callTool).toHaveBeenCalledTimes(2);
    expect(calledToolNames).toEqual([
      "list_databases",
      "get_table_schema",
    ]);
    expect(managedMcpReadOnlyTools).not.toContain("delete_cluster");
    expect(JSON.stringify(result)).not.toContain("super-secret-api-key");
    expect(result.clusterIdSuffix).toBe("123456");
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
  });
});
