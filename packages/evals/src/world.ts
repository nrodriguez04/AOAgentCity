import { CITY_TIMEZONE, startOfDayInZone, type DivisionStatus, type EventLevel } from "@agent-city/core";
import { createTestDatabase, type TestDatabase } from "@agent-city/db/testing";

// A scenario's world: a fresh in-memory database with the real migrations and
// seed (divisions, agents, instructions, permissions, model prices), plus the
// scenario's own fixture rows, timed relative to now so the database clock
// and the run agree.

export const OWNER_ID = "11111111-1111-4111-8111-111111111111";

const HOUR = 3_600_000;

export class World {
  private constructor(
    readonly t: TestDatabase,
    readonly now: Date,
  ) {}

  static async create(): Promise<World> {
    const t = await createTestDatabase({ seed: true });
    await t.sql.query(`insert into owners (user_id, note) values ($1, 'eval')`, [OWNER_ID]);
    return new World(t, new Date());
  }

  close(): Promise<void> {
    return this.t.close();
  }

  hoursAgo(hours: number): Date {
    return new Date(this.now.getTime() - hours * HOUR);
  }

  /** A local (America/Chicago) time of day, `days` days before today. */
  localTime(daysAgo: number, hour: number, minute = 0): Date {
    const today = startOfDayInZone(this.now);
    const day = startOfDayInZone(new Date(today.getTime() - daysAgo * 24 * HOUR + 12 * HOUR));
    return new Date(day.getTime() + (hour * 60 + minute) * 60_000);
  }

  /**
   * The most recent time a weekly schedule fired before now, in local time:
   * lastSlot(1, 8) is last Monday 8:00 (today's, if that has already passed).
   */
  lastSlot(weekday: number, hour: number, minute = 0): Date {
    const dayOfWeek = new Intl.DateTimeFormat("en-US", { timeZone: CITY_TIMEZONE, weekday: "short" });
    const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    for (let daysAgo = 0; daysAgo <= 7; daysAgo++) {
      const slot = this.localTime(daysAgo, hour, minute);
      if (slot < this.now && dayOfWeek.format(slot) === names[weekday]) return slot;
    }
    throw new Error(`no weekday ${weekday} in the last week`);
  }

  /** "Sunday, October 11" in the city's time zone, as HQ's brief heading writes it. */
  today(): string {
    return new Intl.DateTimeFormat("en-US", { timeZone: CITY_TIMEZONE, weekday: "long", month: "long", day: "numeric" }).format(this.now);
  }

  async setStatus(divisionId: string, status: DivisionStatus): Promise<void> {
    await this.t.sql.query(`update divisions set status = $2::division_status where id = $1`, [divisionId, status]);
  }

  async event(e: { division: string; agent?: string; type: string; summary: string; level?: EventLevel; payload?: Record<string, unknown>; at: Date }): Promise<void> {
    await this.t.sql.query(
      `insert into events (ts, division_id, agent_id, type, level, summary, payload) values ($1, $2, $3, $4, $5::event_level, $6, $7::jsonb)`,
      [e.at, e.division, e.agent ?? null, e.type, e.level ?? "info", e.summary, JSON.stringify(e.payload ?? {})],
    );
  }

  /** A finished run, with its cost (spend.summary sums these by the day they started). */
  async run(r: { agent: string; status: "succeeded" | "failed"; costUsd: number; at: Date; minutes?: number; goal?: string; error?: string; trigger?: "cron" | "manual" | "hq" }): Promise<string> {
    const run = await this.t.repo.createRun({ agent_id: r.agent, trigger: r.trigger ?? "cron", goal: r.goal ?? "Scheduled run", model: null });
    const ended = new Date(r.at.getTime() + (r.minutes ?? 4) * 60_000);
    await this.t.sql.query(
      `update runs set created_at = $2, started_at = $2, ended_at = $3, status = $4::run_status, cost_usd = $5, error = $6 where id = $1::uuid`,
      [run.id, r.at, ended, r.status, r.costUsd, r.error ?? null],
    );
    await this.t.sql.query(`update agents set last_checkin_at = $2, state = case when $3 then 'error'::agent_state else state end where id = $1`, [
      r.agent,
      ended,
      r.status === "failed",
    ]);
    return run.id;
  }

  async approval(a: { agent: string; division: string; tier: "external_effect" | "financial"; title: string; rationale: string; tool: string; args: Record<string, unknown>; amountCents?: number; at: Date }): Promise<void> {
    const { approval } = await this.t.repo.createApproval({
      division_id: a.division,
      agent_id: a.agent,
      run_id: null,
      tier: a.tier,
      title: a.title,
      rationale: a.rationale,
      action: { tool: a.tool, args: a.args },
      action_hash: `eval-${a.title}`,
      amount_cents: a.amountCents ?? null,
      currency: a.amountCents == null ? null : "usd",
    });
    await this.t.sql.query(`update approvals set created_at = $2, expires_at = $2::timestamptz + interval '72 hours' where id = $1::uuid`, [approval.id, a.at]);
  }

  async appApproval(a: { app: string; id: string; title: string; risk: "external_effect" | "financial" | "binding"; url: string; at: Date; expiresAt?: Date }): Promise<void> {
    await this.t.sql.query(
      `insert into app_approvals (app, external_id, division_id, title, risk, url, status, requested_at, expires_at)
       values ($1, $2, $1, $3, $4, $5, 'pending', $6, $7)`,
      [a.app, a.id, a.title, a.risk, a.url, a.at, a.expiresAt ?? null],
    );
  }

  async task(x: { division: string; title: string; priority?: number; at?: Date }): Promise<void> {
    const task = await this.t.repo.createTask({ division_id: x.division, title: x.title, notes: null, owner: "nico", status: "open", priority: x.priority ?? 2, due_at: null, source: "nico" });
    if (x.at) await this.t.sql.query(`update tasks set created_at = $2, updated_at = $2 where id = $1::uuid`, [task.id, x.at]);
  }

  /** A knowledge document; written by Nico unless `by` names an agent. */
  async document(d: { division: string; slug: string; title: string; body: string; tags?: string[]; by?: string }): Promise<void> {
    await this.t.sql.query(
      `insert into documents (division_id, slug, title, body_md, tags, updated_by) values ($1, $2, $3, $4, $5::text[], $6)`,
      [d.division, d.slug, d.title, d.body, d.tags ?? [], d.by ?? "owner"],
    );
  }
}
