import postgres from "postgres";

/**
 * The minimal SQL surface the repository needs. Production uses the `postgres`
 * driver against Supabase; tests run the same queries against PGlite with the real
 * migrations applied (see ./testing.ts).
 *
 * Queries use positional parameters ($1, $2 ...) with explicit casts, and lists are
 * passed as comma-separated text, so they behave the same on both drivers.
 */
export interface SqlClient {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  transaction<R>(fn: (tx: SqlClient) => Promise<R>): Promise<R>;
  close(): Promise<void>;
}

export interface PostgresClientOptions {
  /** Max pooled connections. Keep small: Trigger.dev runs many workers. */
  max?: number;
}

/**
 * Connect to Supabase Postgres with a server-side connection string. Use the
 * Supavisor pooler URL; prepared statements are disabled so the transaction-mode
 * pooler (port 6543) works too.
 */
export function createPostgresClient(url: string, options: PostgresClientOptions = {}): SqlClient {
  const sql = postgres(url, {
    prepare: false,
    max: options.max ?? 3,
    idle_timeout: 20,
    connect_timeout: 15,
    onnotice: () => {},
  });

  const wrap = (runner: postgres.Sql | postgres.TransactionSql): SqlClient => ({
    async query<T>(text: string, params: unknown[] = []) {
      const rows = await runner.unsafe(text, params as postgres.ParameterOrJSON<never>[]);
      return rows as unknown as T[];
    },
    async transaction<R>(fn: (tx: SqlClient) => Promise<R>) {
      if ("begin" in runner) {
        return (await runner.begin((tx) => fn(wrap(tx)))) as R;
      }
      return fn(wrap(runner));
    },
    async close() {
      if ("end" in runner) await runner.end({ timeout: 5 });
    },
  });

  return wrap(sql);
}

let shared: SqlClient | undefined;

/** Process-wide client built from DATABASE_URL (worker and scripts). */
export function sqlFromEnv(): SqlClient {
  if (!shared) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL is not set. Use the Supabase pooler connection string (server-side only).");
    }
    shared = createPostgresClient(url);
  }
  return shared;
}
