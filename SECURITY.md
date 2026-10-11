# Security

This repository is public. It holds code and agent definitions only: no credentials, no customer data and no business records.

## Where secrets live

| Secret | Where it is stored | Who reads it |
|---|---|---|
| Integration credentials (Stripe, email, Gmail, GitHub, CrewAI) | Supabase Vault, one secret per agent and integration (`agent:<agent id>:<integration>`) | The worker, through `agent_secret()`, which only the server-side database role can call |
| `DATABASE_URL`, `ANTHROPIC_API_KEY`, `ALERTS_RESEND_API_KEY` and the alert address | Trigger.dev project environment variables | The worker |
| Supabase URL and publishable key | Vercel environment variables | The city, in the browser |

The Supabase publishable key is public by design. Every table has row-level security: a signed-in user reads data only when listed in `owners`, and the browser can change nothing except an approval's decision and note, a draft's review (status, title, text and published link; the database keeps the agent's original text and who reviewed it), knowledge documents (create, edit and archive, never delete; every edit keeps the previous version) and the pause switch (`supabase/migrations/*_security.sql`, `*_draft_review.sql`, `*_knowledge.sql`). Anonymous visitors can read nothing.

`.env` files are git-ignored; only `.env.example`, with empty values, is committed.

## Personal data

Agents read customer data (for example a support email) at run time through the gateway. What they store goes to the database, never to this repository. Test fixtures use reserved domains such as `example.com` and `.test`.

## Dependencies

- `pnpm audit --prod` reports no known vulnerabilities. `ws` is pinned to a patched 8.x through `pnpm.overrides` (it reaches the worker through the Trigger.dev SDK).
- The CrewAI crews depend on `chromadb` through CrewAI. Its open advisories (GHSA-f4j7-r4q5-qw2c, GHSA-2wm9-hf6c-p5cr, GHSA-36p7-vc44-83pf, GHSA-xph7-9rjv-w5fr) concern running a Chroma server. The crews run with `memory=False` and no knowledge sources, so no Chroma server or vector store ever starts.

## Reporting a problem

Open a private report under **Security > Report a vulnerability** on GitHub rather than a public issue.
