# Company connector

How a company app (FedOps, Hålo, ParlayLab, GalleySwap) connects to Agent City. It works in two directions:

- **Events in.** The app reports what happened (a notice qualified, a proposal submitted, an approval waiting) by posting signed events. They appear in the city's activity feed, light the app's tower, and reach HQ's daily brief.
- **Tools out.** Agent City agents call the app's agent API with their own token: to read a pursuit, or to add a note to one.

The app stays the authority for its own data and approvals. Agent City shows the app's approvals and links to them. It never decides them, and an agent token can never do what the app reserves for a person.

## Events in

### Connect the app

1. Generate a signing secret, for example with `openssl rand -hex 32`.
2. Store it in Agent City's Vault (Supabase SQL editor):
   ```sql
   select vault.create_secret('<the secret>', 'app:fedops:events');
   ```
3. Give the same secret to the app as an environment variable, for example `AGENT_CITY_EVENTS_SECRET`, and tell it the endpoint:
   `https://<project-ref>.supabase.co/functions/v1/app-events` (the city's `NEXT_PUBLIC_SUPABASE_URL` plus `/functions/v1/app-events`).

Until step 2 is done, every request from that app is rejected. To rotate the secret, update both places. Events sent in between are rejected with 401, and the app's retries deliver them afterwards.

### Send an event

`POST` the JSON body with three headers:

| Header | Value |
|---|---|
| `X-Agent-City-App` | `fedops`, `halo`, `parlaylab` or `galleyswap` |
| `X-Agent-City-Timestamp` | The current time in Unix seconds. Requests more than 5 minutes off are rejected. |
| `X-Agent-City-Signature` | `sha256=` and the lowercase hex HMAC-SHA256 of `<timestamp>.<body>`, keyed with the app's secret. Sign the exact bytes you send. |

The body (at most 64 KB):

```json
{
  "id": "evt_01J9ZK3V7Q",
  "type": "fedops.opportunity.qualified",
  "summary": "Janitorial services, VA medical center: fit 82, eligible",
  "level": "success",
  "occurred_at": "2026-10-11T12:00:00Z",
  "payload": { "pursuit": "PUR-2026-0004", "fit": 82 }
}
```

| Field | Rules |
|---|---|
| `id` | Required, 1 to 200 characters, unique per app. Resending an id is answered as a duplicate, so retries are safe. |
| `type` | Required: `<app>.<subject>.<verb>`, optionally with one more segment (`fedops.pursuit.stage.changed`). Lowercase letters, digits and underscores. An app can only send its own namespace. |
| `summary` | Required, 1 to 200 characters, one line. It is what the activity feed and HQ's brief show. |
| `level` | `info` (default), `success` (flashes the app's tower), `warning` or `error` (turns its crown red until acknowledged). |
| `occurred_at` | Optional ISO time; stored in the payload. |
| `payload` | Optional JSON object with ids and numbers the event refers to. |
| `approval` | Optional; see below. |

**No personal data.** Summaries and payloads are stored in Agent City and read by its agents. Send ids, counts and links. Never send names, email addresses or phone numbers of leads, customers or employees: a Hålo event says "Lead L-2041 moved to offer", not who the lead is.

### Responses

| Status | Meaning | What the app does |
|---|---|---|
| 202 | Stored. `{"status":"accepted","event_id":123}` | Done. |
| 200 | Already stored under this id. `{"status":"duplicate"}` | Done. |
| 401 | `signature rejected`: wrong secret, the app is not connected, or the body changed after signing | Check the secret; retry later with backoff. |
| 422 | The event breaks a rule; `message` says which | Fix it. Resending it unchanged will fail again. |
| 400, 405, 413 | A missing header, a wrong method, a body over 64 KB | Fix the request. |
| 503 | Agent City could not store it | Retry with backoff. |

The simplest reliable sender is an outbox: write the event to the app's own table in the same transaction as the change it describes, and let a worker post it, retrying 401 and 503 with backoff. FedOps' outbox and pg-boss worker fit this as they are.

### Mirror an approval

When something in the app waits for a person, include `approval` on the event that reports it, and send the same approval again when it is decided or expires:

```json
{
  "id": "evt_01J9ZK4B2M",
  "type": "fedops.approval.requested",
  "summary": "Bid decision: Janitorial services, VA medical center",
  "level": "warning",
  "approval": {
    "id": "APV-2026-0004",
    "title": "Bid decision: Janitorial services, VA medical center",
    "risk": "external_effect",
    "url": "https://fedops.app/approvals/APV-2026-0004",
    "status": "pending",
    "requested_at": "2026-10-11T12:00:00Z",
    "expires_at": "2026-10-14T12:00:00Z"
  }
}
```

| Field | Rules |
|---|---|
| `id` | Required; the app's own approval id. Later events with the same id update the mirror. |
| `title` | Required, up to 200 characters. |
| `risk` | `external_effect` (leaves the building; FedOps YELLOW), `financial` (moves money) or `binding` (legal or contractual liability; FedOps RED). |
| `url` | Where to decide it. `https://` only. |
| `status` | `pending`, `approved`, `rejected`, `expired` or `cancelled`. |
| `requested_at`, `expires_at`, `decided_at` | ISO times. `requested_at` defaults to now. |

A pending approval shows in the city's Approvals tab under "Waiting in your apps", lights the app's beacon, is emailed once in the owner digest with its link, and appears in HQ's brief. Decide it in the app; the app's next event closes it here.

### Example senders

TypeScript (Node 18 or newer):

```ts
import { createHmac } from "node:crypto";

export async function sendToAgentCity(event: object): Promise<void> {
  const body = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", process.env.AGENT_CITY_EVENTS_SECRET!).update(`${timestamp}.${body}`).digest("hex");
  const response = await fetch(process.env.AGENT_CITY_EVENTS_URL!, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Agent-City-App": "fedops",
      "X-Agent-City-Timestamp": String(timestamp),
      "X-Agent-City-Signature": `sha256=${signature}`,
    },
    body,
  });
  if (response.status === 422) throw new Error(`Agent City refused the event: ${(await response.json()).message}`); // do not retry
  if (!response.ok) throw new Error(`Agent City answered ${response.status}`); // retry with backoff
}
```

Python (standard library only):

```python
import hashlib, hmac, json, os, time, urllib.request

def send_to_agent_city(event: dict) -> None:
    body = json.dumps(event, separators=(",", ":")).encode()
    timestamp = str(int(time.time()))
    digest = hmac.new(os.environ["AGENT_CITY_EVENTS_SECRET"].encode(), timestamp.encode() + b"." + body, hashlib.sha256).hexdigest()
    request = urllib.request.Request(
        os.environ["AGENT_CITY_EVENTS_URL"],
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Agent-City-App": "halo",
            "X-Agent-City-Timestamp": timestamp,
            "X-Agent-City-Signature": "sha256=" + digest,
        },
    )
    urllib.request.urlopen(request, timeout=10)  # raises on 4xx/5xx; retry 401 and 503 with backoff
```

### How it is checked

`supabase/functions/app-events` checks the request's shape and passes the raw body to `public.ingest_app_event()`, which only the service role may call. The database verifies the signature against the Vault secret (the secret never leaves the database), rejects stale timestamps, other apps' namespaces and malformed bodies, and stores the event, its receipt and any approval in one transaction. A rejected event leaves nothing behind. Tests: `packages/db/test/connector.test.ts`.

## Tools out

### What the app provides

An agent API under one base URL, for example `https://fedops.app/api/agent/v1`, that:

- authenticates `Authorization: Bearer <token>`, with **one token per Agent City agent**, scoped to what that agent may do (read, or draft inside the app), and revocable on its own;
- records `X-Agent-City-Agent` and `X-Agent-City-Run` in the app's audit trail, so every change names the agent and run that asked for it;
- honours `Idempotency-Key` on writes: the same key never acts twice;
- answers JSON, with `{"error": "...", "message": "..."}` and the usual status codes on failure (401 bad token, 403 outside the token's scope, 404, 409, 422, 429);
- never lets an agent token do what needs a person. In FedOps, GREEN capabilities can be tools; a YELLOW or RED action becomes an approval inside FedOps, decided there under its own rules (including the two-person rule), and mirrored back through an event.

### Connect an agent

Store the agent's token and the base URL in Vault:

```sql
select vault.create_secret('{"base_url":"https://fedops.app/api/agent/v1","token":"<token for this agent>"}', 'agent:fedops.capture-01:fedops');
```

`pnpm preflight` lists any agent whose app token is missing.

### Declare a tool

```ts
import { z } from "zod";
import { defineServiceTool } from "../service";

export const fedopsGetPursuit = defineServiceTool({
  app: "fedops",
  name: "fedops.get_pursuit",
  description: "One pursuit: its notice, fit and eligibility scores, stage and open questions.",
  tier: "read",
  method: "GET",
  path: "/pursuits/{pursuit_id}",
  schema: z.object({ pursuit_id: z.string().regex(/^PUR-\d{4}-\d{4}$/) }),
  describe: (a) => `Read pursuit ${a.pursuit_id}`,
});
```

Register it in `packages/tools/src/registry.ts` and grant it in the agent's definition. Path fields come from the arguments; a `GET` sends the rest as query parameters, a write sends them as JSON with an idempotency key (the approval id when an approved action executes, otherwise derived from the run and arguments). Responses are marked as data written by outsiders, capped at 200,000 characters, and errors are turned into messages the agent can act on. Tests: `packages/tools/test/service.test.ts`.
