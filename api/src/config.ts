export interface Config {
  databaseUrl: string;
  port: number;
  demoTenantId: string;
  evidenceBucket?: string;
  awsRegion: string;
  mcpServerUrl: string;
  mcpClusterId?: string;
  mcpApiKey?: string;
  bedrockModelId?: string;
  databasePoolMax: number;
}

export function loadConfig(): Config {
  return {
    databaseUrl:
      process.env.DATABASE_URL ??
      "postgresql://root@localhost:26257/recallops?sslmode=disable",
    port: Number(process.env.API_PORT ?? 8787),
    demoTenantId: process.env.DEMO_TENANT_ID ?? "demo-logistics",
    evidenceBucket: process.env.EVIDENCE_BUCKET || undefined,
    awsRegion: process.env.AWS_REGION ?? "us-east-1",
    mcpServerUrl: process.env.MCP_SERVER_URL ?? "https://cockroachlabs.cloud/mcp",
    mcpClusterId: process.env.MCP_CLUSTER_ID || undefined,
    mcpApiKey: process.env.MCP_SERVICE_ACCOUNT_API_KEY || undefined,
    bedrockModelId: process.env.BEDROCK_MODEL_ID || undefined,
    databasePoolMax: Math.min(4, Math.max(1, Number(process.env.DATABASE_POOL_MAX ?? 2))),
  };
}
