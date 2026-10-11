// Test harness: an in-memory Postgres (PGlite) with the real migrations applied
// on top of small stand-ins for the Supabase pieces they reference (auth.uid(),
// roles, Vault, pg_net, the realtime publication). Not used in production.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { Repo } from "./repo";
import type { SqlClient } from "./sql";

export const SUPABASE_DIR = fileURLToPath(new URL("../../../supabase/", import.meta.url));

const SUPABASE_STUBS = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;

  create schema auth;
  grant usage on schema auth to anon, authenticated;
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(coalesce(current_setting('request.jwt.claim.sub', true),
                           current_setting('request.jwt.claims', true)::jsonb ->> 'sub'), '')::uuid
  $$;

  create schema vault;
  create table vault.secrets_stub (name text primary key, secret text not null);
  create view vault.decrypted_secrets as select name, secret as decrypted_secret from vault.secrets_stub;

  create schema net;
  create table net.requests_stub (
    id bigint generated always as identity primary key,
    url text, body jsonb, headers jsonb, created_at timestamptz default now()
  );
  create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}',
                                headers jsonb default '{}', timeout_milliseconds int default 5000)
  returns bigint language sql as $$
    insert into net.requests_stub (url, body, headers) values (url, body, headers) returning id
  $$;

  create publication supabase_realtime;

  -- Supabase keeps extensions (pgcrypto, pg_net, ...) in their own schema.
  create schema extensions;
  grant usage on schema extensions to anon, authenticated, service_role;
`;

function wrapPglite(db: PGlite | Transaction): SqlClient {
  return {
    async query<T>(text: string, params: unknown[] = []) {
      const result = await db.query<T>(text, params as unknown[]);
      return result.rows;
    },
    async transaction<R>(fn: (tx: SqlClient) => Promise<R>) {
      if ("transaction" in db && typeof db.transaction === "function") {
        return (db as PGlite).transaction((tx) => fn(wrapPglite(tx)));
      }
      return fn(wrapPglite(db));
    },
    async close() {
      if ("close" in db && typeof db.close === "function") await (db as PGlite).close();
    },
  };
}

export function migrationFiles(): string[] {
  const dir = `${SUPABASE_DIR}migrations/`;
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => `${dir}${f}`);
}

export interface TestDatabase {
  db: PGlite;
  sql: SqlClient;
  repo: Repo;
  /** Run `fn` as an authenticated Supabase user (RLS applies). */
  asUser<R>(userId: string, fn: (sql: SqlClient) => Promise<R>): Promise<R>;
  /** Put a value in the Vault stand-in. */
  setSecret(name: string, value: string): Promise<void>;
  /** Requests recorded by the pg_net stand-in. */
  netRequests(): Promise<{ url: string; body: unknown; headers: Record<string, string> }[]>;
  close(): Promise<void>;
}

// Migrating takes a couple of seconds, so each process builds one template per
// variant and every test gets a cheap clone of it.
const templates = new Map<string, Promise<PGlite>>();

async function buildTemplate(seed: boolean): Promise<PGlite> {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(SUPABASE_STUBS);
  for (const file of migrationFiles()) {
    try {
      await db.exec(readFileSync(file, "utf8"));
    } catch (error) {
      throw new Error(`migration ${file} failed: ${(error as Error).message}`);
    }
  }
  if (seed) {
    const seedFile = `${SUPABASE_DIR}seed.sql`;
    if (!existsSync(seedFile)) throw new Error("supabase/seed.sql is missing. Run `pnpm gen:seed`.");
    await db.exec(readFileSync(seedFile, "utf8"));
  }
  return db;
}

export async function createTestDatabase(options: { seed?: boolean } = {}): Promise<TestDatabase> {
  const key = options.seed ? "seeded" : "empty";
  if (!templates.has(key)) templates.set(key, buildTemplate(Boolean(options.seed)));
  const db = (await (await templates.get(key)!).clone()) as PGlite;

  const sql = wrapPglite(db);
  return {
    db,
    sql,
    repo: new Repo(sql),
    async asUser(userId, fn) {
      return db.transaction(async (tx) => {
        await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
        await tx.exec(`set local role authenticated`);
        return fn(wrapPglite(tx));
      });
    },
    async setSecret(name, value) {
      await db.query(
        `insert into vault.secrets_stub (name, secret) values ($1, $2)
         on conflict (name) do update set secret = excluded.secret`,
        [name, value],
      );
    },
    async netRequests() {
      const result = await db.query<{ url: string; body: unknown; headers: Record<string, string> }>(
        `select url, body, headers from net.requests_stub order by id`,
      );
      return result.rows;
    },
    close: () => db.close(),
  };
}

/** Minimal fixture rows for tests that don't load the generated seed. */
export async function insertFixtures(t: TestDatabase): Promise<void> {
  await t.db.exec(`
    insert into divisions (id, name, kind, status) values
      ('hq', 'HQ', 'hq', 'planning'),
      ('parlaylab', 'ParlayLab', 'business', 'live');
    insert into agents (id, division_id, display_name, role, model_tier, instructions, daily_budget_usd) values
      ('hq.hq-01', 'hq', 'HQ-01', 'Daily brief and routing', 'reasoning', 'You are HQ.', 5),
      ('parlaylab.billing-01', 'parlaylab', 'BILLING-01', 'Subscription operations', 'standard', 'You are billing.', 1.5);
  `);
}
