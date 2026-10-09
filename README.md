# Agent City

A multi-agent operating system for running Nico's businesses and life, with a live 3D "mini Manhattan at dusk" as its interface. Agents do narrow jobs (billing, support, growth), HQ reasons across everything, every side effect waits in an approval queue, and the city renders exactly what the event store says: a tower lights up floor by floor when its agents work, its beacon flashes amber while something waits on you, and its crown turns red when a run fails.

Built from `agent-city-build-spec.md` (v1.0). Section numbers below (§) refer to that spec.

```
CITY UI (Next.js + React Three Fiber)      apps/city
  reads realtime state, renders the city, writes approval decisions + the pause switch
        |  Supabase Realtime                    ^ approvals.status / settings.agents_paused
EVENT STORE (Supabase Postgres)            supabase/migrations
  divisions, agents, runs, events, approvals, tasks, briefs  (+ RLS, triggers)
        |  DATABASE_URL (server only)           ^ pg_net -> execute-approval
HQ + DIVISION AGENTS (Trigger.dev tasks)   apps/worker, packages/runtime, packages/agents
  scheduled / dispatched runs, Claude tool-use loop, budgets, kill switch
        |
TOOL GATEWAY                               packages/tools
  registry with risk tiers, least-privilege grants, approval gate, scoped secrets, audit log
        |
INTEGRATIONS: Stripe, Resend / Gmail, Claude (fast-model classification)
```

## Try it now (no accounts needed)

```bash
pnpm install
pnpm city            # http://localhost:3000
```

Without Supabase variables the city runs in **demo mode**: a local simulation of the agents drives the same store, panels and 3D city, including approvals you can approve or reject. Add `?demo` to the URL to force it even when Supabase is configured.

## Repository layout

```
apps/
  city/            Next.js 16 + R3F city. lib/visual-state.ts is the pure state -> visuals mapping (§10.5)
  worker/          Trigger.dev v4 tasks: division-run, agent-scheduled-run, hq-daily-brief,
                   execute-approval, sweep-approvals; scripts for sync, manual runs, Phase 1 check
packages/
  core/            Event contract (zod), row types, enums, risk tiers, model config + pricing, divisions
  db/              SQL repository, emit(), PGlite test harness that runs the real migrations
  tools/           Tool registry, gateway (§7.2), policy, Stripe / email / Gmail / internal / HQ tools
  runtime/         Agent run loop (§6.2), budgets, kill switch, approval execution (§7.3), sweeper
  agents/          defineAgent() + instructions.md for HQ-01, BILLING-01, SUPPORT-01, GROWTH-01
supabase/
  migrations/      0001 schema, 0002 RLS + Vault access, 0003 approval-decision triggers
  seed.sql         GENERATED from packages/agents + packages/core (`pnpm gen:seed`)
assets/blender/    Hero tower source: a Blender Python script that builds and exports every tower
```

## Going live

### 1. Supabase

1. Create a project. Apply the migrations in order (`supabase link` then `supabase db push`, or paste `0001`, `0002`, `0003` into the SQL editor), then run `supabase/seed.sql`.
2. **Auth**: turn off public sign-ups, invite your own email (Authentication -> Users), sign in once, then make yourself the owner:
   ```sql
   insert into owners (user_id, note) values ('<your auth user id>', 'nico');
   ```
   The city shows this exact statement with your id if you sign in before doing it. Add the city's URL to the Auth redirect URLs.
3. **Secrets in Vault**, one per agent and integration (§7.4):
   ```sql
   select vault.create_secret('rk_live_...', 'agent:parlaylab.billing-01:stripe');
   select vault.create_secret('rk_live_...', 'agent:parlaylab.growth-01:stripe');
   select vault.create_secret('rk_live_...', 'agent:parlaylab.support-01:stripe');
   select vault.create_secret('re_...',      'agent:parlaylab.billing-01:email');
   select vault.create_secret('{"provider":"gmail","client_id":"...","client_secret":"...","refresh_token":"..."}', 'agent:parlaylab.support-01:gmail');
   select vault.create_secret('{"provider":"gmail", ...same account, with gmail.send scope...}', 'agent:parlaylab.support-01:email');
   select vault.create_secret('tr_prod_...', 'trigger_secret_key');  -- lets approvals execute instantly
   ```
   Stripe restricted keys: BILLING-01 needs read on subscriptions, invoices, customers, charges and write on refunds; GROWTH-01 read on subscriptions, prices, products, customers; SUPPORT-01 read on customers, subscriptions, charges.
4. **pg_net** (Database -> Extensions) powers instant approval dispatch. Migration 0003 enables it when available; without it, the sweeper executes approved actions within 5 minutes.

### 2. Trigger.dev

1. Create a project; set `TRIGGER_PROJECT_REF`. Add the worker variables from `.env.example` to the project's environment (`DATABASE_URL`, `ANTHROPIC_API_KEY`, `EMAIL_FROM`, optional `MODEL_*`, `EFFORT_*`, `AGENTS_PAUSED`).
2. Deploy: `pnpm --filter @agent-city/worker deploy` (or `pnpm --filter @agent-city/worker dev` locally).
3. Register agent schedules (America/Chicago) and sync definitions: `pnpm agents:sync`. HQ-01's 6:55 AM brief is scheduled in code (`hq-daily-brief`).

### 3. City

Deploy `apps/city` to Vercel (root directory `apps/city`, install with pnpm from the repo root) with `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Locally, put them in `apps/city/.env.local`.

## Build plan checks (§12)

| Phase | Done when | How |
|---|---|---|
| 1 Foundation | A manual script emits a test event and `agents.state` updates | `pnpm emit:test` |
| 2 First live agent | BILLING-01 runs against real Stripe data, writes a summary event, stores transcript and cost | `pnpm agent:run parlaylab.billing-01` |
| 3 Approval gate | An action is requested, approved, executed exactly once, `action.executed` logged | Approve in the city (or `update approvals set status = 'approved' where id = ...`); the database triggers `execute-approval` |
| 4 City goes live | BILLING-01 lights the ParlayLab tower, a pending approval flashes its beacon, approving from the panel executes it | Open the city while running phase 2 and 3 |
| 5 HQ | HQ produces a brief from real state and dispatches a run | `pnpm agent:run hq.hq-01`, then the Brief tab |
| 6 Visual upgrade | Miniature night-time Manhattan, live state still drives effects | Low graphics toggle for weaker machines |

## How an approval works

1. An agent calls an `external_effect` or `financial` tool. The gateway validates the arguments, strips `_rationale`, stores `{tool, args}` verbatim with a hash, and emits `approval.requested`. The tool does **not** run. An identical open action from the same agent is deduplicated.
2. The run finishes as `waiting_approval` without blocking; the tower's beacon flashes.
3. Nico approves in the panel. RLS allows only `status` and `decided_note` on a pending, unexpired approval. A trigger stamps `decided_at`, emits `approval.decided`, frees the agent, and calls Trigger.dev through pg_net with idempotency key = approval id.
4. `execute-approval` re-checks the agent, its grant and the arguments, then claims the approval (`approved -> executing`, a single conditional update), runs the stored action with the approval id as the integration's idempotency key, records the result and emits `action.executed`. The model is never re-invoked.
5. Approvals expire after 72 hours. The sweeper (every 5 minutes) expires them, executes anything the webhook missed, and fails runs whose worker died. If a worker dies in the middle of an action, the approval stays `executing` (never retried, and the same action can't be queued again) and the city raises one red "outcome unknown" alert so you can check the integration.

## Safety (security checklist, §13)

| Requirement | Where |
|---|---|
| Service credentials never reach the browser | The city uses the anon key + Nico's session only; the worker uses `DATABASE_URL` server-side |
| RLS on every table; browser can only decide approvals | `0002_security.sql` (column grants: `approvals.status, decided_note`, `settings.agents_paused`) |
| Every tool registered with a tier | `packages/tools/src/registry.ts` (unknown tools are rejected and logged) |
| External and financial tools always need approval, no bypass | `requiresApproval()` in the gateway; no flag exists |
| No money movement for Finances | Finances has no agents or tools; refunds are the only money-moving tool and are `financial` |
| Scoped credentials in a vault | `agent_secret()` reads Vault per `(agent, integration)` |
| Every tool call logged with args and result | `tool_calls` table |
| Approvals expire after 72 h and execute idempotently | `expires_at`, the `executing` claim, integration idempotency keys |
| Kill switch | `AGENTS_PAUSED=true` or the Pause city button: checked before every run, between steps, and before executing approvals |
| Daily budget caps | Checked before each run (spend today + estimate) and after every model call |
| Prompt injection | Runtime rules + per-agent instructions treat fetched content as data; email tools wrap content with an untrusted-data notice; the approval gate is the backstop |

## Decisions and deviations from the spec

- **Worker database access** uses a pooled `DATABASE_URL` instead of the service-role key, so atomic claims and multi-statement updates are plain SQL and the exact queries are tested against the real migrations.
- **`executing` approval status** and an **`action_hash`** unique index were added for single execution and dedupe; `tool_calls`, `settings`, `model_pricing`, `email_drafts` and `owners` tables were added for the audit log, pause switch, pricing table, drafts and owner check.
- **`decided_at`** is stamped by a trigger instead of trusted from the browser.
- **Retries** happen per Claude API call (SDK backoff on 408/409/429/5xx), not by re-running whole tasks, so tool calls are never repeated.
- **Window lighting**: each agent lights its own band of floors (floor by floor) rather than a single floor, so a three-agent tower is fully lit when all three work.
- **Refusal fallbacks** (`fallbacks: "default"`) are on for the Opus and Sonnet tiers; Haiku has no server-side fallback. Disable with `MODEL_FALLBACKS=off`.
- **Hero towers** are modelled in Blender by a script (`assets/blender/`) and shipped as GLB; the filler city is procedural and instanced.

## Open decisions (§1)

- **AverageOutput / OTHERLIFE**: modelled as one division (AverageOutput, with OTHERLIFE as its product). Splitting it is a new entry in `packages/core/src/divisions.ts` plus `pnpm gen:seed`.
- **ParlayLab's first jobs**: the spec's suggested defaults (BILLING-01, SUPPORT-01, GROWTH-01) are implemented. Change tools, schedules or instructions in `packages/agents/parlaylab/*`, then `pnpm gen:seed` and `pnpm agents:sync`.

## Development

```bash
pnpm typecheck
pnpm test            # includes migrations + RLS + approval triggers on PGlite
pnpm gen:seed        # after changing agents or divisions (a test fails if you forget)
pnpm --filter @agent-city/city build
```
