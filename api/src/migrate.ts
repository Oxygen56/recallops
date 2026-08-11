import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { loadConfig } from "./config.js";

const config = loadConfig();
const schemaPath = resolve(process.cwd(), "../sql/schema.sql");
const schema = await readFile(schemaPath, "utf8");
const bootstrapUrl = config.databaseUrl.replace(/\/recallops(?=\?|$)/, "/defaultdb");
const pool = new Pool({ connectionString: bootstrapUrl, application_name: "recallops-migration" });

try {
  await pool.query(schema);
  console.log("RecallOps CockroachDB schema is ready.");
} finally {
  await pool.end();
}
