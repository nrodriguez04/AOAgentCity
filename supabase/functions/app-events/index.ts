// app-events: company apps (FedOps, Hålo, ParlayLab, GalleySwap) POST signed
// events here. Deployed with verify_jwt off: apps have no Supabase session,
// and every request is authenticated by its HMAC signature instead
// (handler.ts, docs/CONNECTOR.md).
import { createHandler, serviceHeadersFromEnv } from "./handler.ts";

Deno.serve(
  createHandler({
    supabaseUrl: Deno.env.get("SUPABASE_URL")!,
    serviceHeaders: serviceHeadersFromEnv((name) => Deno.env.get(name)),
    log: (line) => console.log(line),
  }),
);
