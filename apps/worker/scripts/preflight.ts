// What is still missing before Agent City can do real work: worker settings, the
// owner account, every enabled agent's credentials, alerts. Prints a checklist and
// never a secret. Exits non-zero only when agents cannot run at all.
//   DATABASE_URL=... pnpm preflight        (reads ../../.env when present)
//   pnpm preflight --ci                     (deploy workflow: skips the worker's own variables,
//                                            which live in Trigger.dev)
import { Repo, sqlFromEnv } from "@agent-city/db";
import { formatPreflight, preflight } from "@agent-city/runtime";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set: Supabase -> Project Settings -> Database -> Connection string (Transaction pooler).");
  process.exit(1);
}
const sql = sqlFromEnv();
try {
  const checks = await preflight({ repo: new Repo(sql), workerEnv: !process.argv.includes("--ci") });
  console.log(formatPreflight(checks));
  process.exitCode = checks.some((c) => c.required && !c.ok) ? 1 : 0;
} finally {
  await sql.close();
}
