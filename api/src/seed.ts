import { loadConfig } from "./config.js";
import { seedDemo } from "./demoData.js";
import { CockroachRepository } from "./repository.js";

const config = loadConfig();
const repository = new CockroachRepository(config.databaseUrl);
try {
  await seedDemo(repository, config.demoTenantId);
  console.log("Seeded three synthetic, provenance-bearing memories.");
} finally {
  await repository.close();
}
