// Execute an approved action locally (normally the execute-approval task does this).
//   DATABASE_URL=... pnpm approval:execute <approvalId>
import { Repo, sqlFromEnv } from "@agent-city/db";
import { executeApproval } from "@agent-city/runtime";

const approvalId = process.argv[2];
if (!approvalId) {
  console.error("usage: pnpm approval:execute <approvalId>");
  process.exit(1);
}
const sql = sqlFromEnv();
console.log(await executeApproval({ repo: new Repo(sql) }, approvalId));
await sql.close();
