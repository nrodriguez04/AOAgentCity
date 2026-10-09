// Writes supabase/seed.sql from the agent and division definitions.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AGENTS, seedSql } from "../src";

const target = fileURLToPath(new URL("../../../supabase/seed.sql", import.meta.url));
writeFileSync(target, seedSql(AGENTS));
console.log(`wrote ${target} (${AGENTS.length} agents)`);
