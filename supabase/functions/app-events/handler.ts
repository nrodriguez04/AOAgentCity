// Request handling for the app-events Edge Function. No Deno APIs here, so the
// database tests can run it against the real migrations
// (packages/db/test/connector.test.ts). Protocol: docs/CONNECTOR.md.
//
// A thin proxy on purpose. It checks the request's shape, then hands the raw
// body and signature to public.ingest_app_event(), which verifies the HMAC
// against the app's secret in Vault, so the signing secret never leaves the
// database. The function holds only the service key, which ingest_app_event
// requires: the public (publishable) key cannot reach it.

/** Same list as APP_IDS in packages/core/src/apps.ts. */
export const APPS: readonly string[] = ["fedops", "halo", "parlaylab", "galleyswap"];
export const MAX_BODY_BYTES = 65_536;

export interface HandlerOptions {
  /** The project's API URL (SUPABASE_URL). */
  supabaseUrl: string;
  /** Headers that authenticate as the service role (see serviceHeadersFromEnv). */
  serviceHeaders: Record<string, string>;
  fetch?: typeof fetch;
  /** Operational log lines. Never given bodies, signatures or keys. */
  log?: (line: string) => void;
}

/**
 * A secret key (sb_secret_...) goes on the apikey header only; a legacy
 * service_role key, a JWT, also goes on Authorization.
 */
export function serviceHeadersFromEnv(get: (name: string) => string | undefined): Record<string, string> {
  const keys = get("SUPABASE_SECRET_KEYS");
  if (keys) {
    try {
      const key = (JSON.parse(keys) as Record<string, string>).default;
      if (key) return { apikey: key };
    } catch {
      // fall back to the legacy key
    }
  }
  const legacy = get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return { apikey: legacy, Authorization: `Bearer ${legacy}` };
  throw new Error("app-events: no service key in the function environment");
}

const reply = (status: number, error: string, message: string, headers: Record<string, string> = {}) =>
  Response.json({ error, message }, { status, headers });

export function createHandler(options: HandlerOptions): (req: Request) => Promise<Response> {
  const doFetch = options.fetch ?? fetch;
  const log = options.log ?? (() => {});
  const rpcUrl = `${options.supabaseUrl.replace(/\/+$/, "")}/rest/v1/rpc/ingest_app_event`;

  return async (req) => {
    if (req.method !== "POST") return reply(405, "method_not_allowed", "POST a signed event.", { Allow: "POST" });

    const app = req.headers.get("x-agent-city-app") ?? "";
    const timestamp = req.headers.get("x-agent-city-timestamp") ?? "";
    const signature = req.headers.get("x-agent-city-signature") ?? "";
    if (!APPS.includes(app)) return reply(400, "unknown_app", `X-Agent-City-App must be one of: ${APPS.join(", ")}.`);
    if (!/^\d{9,11}$/.test(timestamp)) return reply(400, "bad_timestamp", "X-Agent-City-Timestamp must be the current time in Unix seconds.");
    if (!/^sha256=[0-9a-f]{64}$/.test(signature)) return reply(401, "unauthorized", "signature rejected");

    if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return reply(413, "too_large", "Events are limited to 64 KB.");
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.byteLength > MAX_BODY_BYTES) return reply(413, "too_large", "Events are limited to 64 KB.");
    let body: string;
    try {
      // Exactly the signed bytes: no replacement characters, and a BOM is kept, not dropped.
      body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return reply(400, "not_utf8", "The body must be UTF-8 JSON.");
    }

    let response: Response;
    try {
      response = await doFetch(rpcUrl, {
        method: "POST",
        headers: { ...options.serviceHeaders, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ p_app: app, p_timestamp: Number(timestamp), p_signature: signature, p_body: body }),
      });
    } catch (error) {
      log(`app-events: database unreachable (${error instanceof Error ? error.name : "error"})`);
      return reply(503, "unavailable", "Agent City could not store the event. Retry with backoff.");
    }

    const result = (await response.json().catch(() => null)) as { status?: string; event_id?: number; code?: string; message?: string } | null;
    if (response.ok && result?.status) {
      log(`app-events: ${app} ${result.status}`);
      return Response.json(result, { status: result.status === "accepted" ? 202 : 200 });
    }
    const code = String(result?.code ?? "");
    if (code === "28000") {
      log(`app-events: ${app} signature rejected`);
      return reply(401, "unauthorized", "signature rejected");
    }
    // Class 22 (bad value) and 23 (constraint): the event itself is wrong; resending it unchanged will not help.
    if (/^2[23]/.test(code)) return reply(422, "invalid_event", String(result?.message ?? "invalid event").slice(0, 300));
    log(`app-events: ingest failed with HTTP ${response.status} ${code}`);
    return reply(503, "unavailable", "Agent City could not store the event. Retry with backoff.");
  };
}
