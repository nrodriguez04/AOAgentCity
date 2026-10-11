import {
  DIVISIONS,
  formatMinorUnits,
  type AgentRow,
  type ApprovalRow,
  type BriefRow,
  type DivisionRow,
  type DraftRow,
  type EventRow,
  type EventType,
  type MetricValue,
  type TaskRow, type DraftReview, type DocumentEdit, type DocumentInput, type DocumentRow } from "@agent-city/core";
import { useCity } from "./store";

// Demo mode: a local simulation that drives the same store the realtime feed
// does, so the city, panels and approval flow can be seen without Supabase.
// Used when NEXT_PUBLIC_SUPABASE_URL is not set, or with ?demo in the URL.

type Level = EventRow["level"];

const DEMO_AGENTS: Pick<AgentRow, "id" | "division_id" | "display_name" | "role" | "model_tier" | "schedule_cron" | "runtime">[] = [
  { id: "hq.hq-01", division_id: "hq", display_name: "HQ-01", role: "Daily brief and routing", model_tier: "reasoning", schedule_cron: "55 6 * * *", runtime: "claude" },
  { id: "parlaylab.billing-01", division_id: "parlaylab", display_name: "BILLING-01", role: "Subscription operations", model_tier: "standard", schedule_cron: "0 8,17 * * *", runtime: "claude" },
  { id: "parlaylab.support-01", division_id: "parlaylab", display_name: "SUPPORT-01", role: "Support inbox triage and replies", model_tier: "standard", schedule_cron: "30 9,13,17 * * *", runtime: "claude" },
  { id: "parlaylab.growth-01", division_id: "parlaylab", display_name: "GROWTH-01", role: "Signups, conversions and MRR", model_tier: "standard", schedule_cron: "15 9 * * *", runtime: "claude" },
  // CrewAI crews (crews/*), working alongside the Claude agents.
  { id: "averageoutput.devlog-crew", division_id: "averageoutput", display_name: "DEVLOG CREW", role: "Weekly OTHERLIFE devlog: analyst, writer, editor", model_tier: "standard", schedule_cron: "0 15 * * 5", runtime: "crewai" },
  { id: "creatoros.content-crew", division_id: "creatoros", display_name: "CONTENT CREW", role: "Weekly content plan and posts: strategist, writer, editor", model_tier: "standard", schedule_cron: "0 8 * * 1", runtime: "crewai" },
  { id: "parlaylab.review-crew", division_id: "parlaylab", display_name: "REVIEW CREW", role: "Weekly business review: analyst, strategist", model_tier: "standard", schedule_cron: "15 7 * * 1", runtime: "crewai" },
];

type DemoDraft = Pick<DraftRow, "kind" | "channel" | "title" | "body_md">;

/** What each crew does in the demo: its tasks in order, then the drafts and tasks it hands back. */
const CREW_SCRIPTS: Record<string, { goal: string; steps: { member: string; label: string }[]; summary: string; drafts: DemoDraft[]; tasks: { title: string; priority: number }[] }> = {
  "averageoutput.devlog-crew": {
    goal: "Turn this week's AOWorld commits into an OTHERLIFE devlog draft and two or three social posts for Nico to review.",
    steps: [
      { member: "Analyst", label: "Sorting the week's commits into player-facing changes" },
      { member: "Writer", label: "Writing the devlog and social posts" },
      { member: "Editor", label: "Fact-checking every claim against the commits" },
    ],
    summary: "Devlog 2 drafted: the naval canon, Aurora's road corridors and 11 fixes",
    drafts: [
      {
        kind: "devlog",
        channel: "blog",
        title: "OTHERLIFE devlog 2: roads, harbours and what lies under the water",
        body_md:
          "# OTHERLIFE devlog 2: roads, harbours and what lies under the water\n\nThis week was about connecting Aurora. The world builder now reads a single geography manifest, so states, coastlines and the long road corridors between cities come from one source of truth instead of hand-placed pieces.\n\n## Under the water\nWe wrote down how the undersea world works: submarines, naval jobs and what you will find off the coast. It is canon for now, not gameplay yet, and we will show it when it is playable.\n\n## Also this week\n- 11 fixes to persistence and streaming\n- Harbour footprints placed for the coastal cities\n\n## What's next\nMore of the map becomes a place you can drive through. No dates; we will show it when it works.",
      },
      { kind: "social_post", channel: "x", title: "X: devlog 2", body_md: "OTHERLIFE devlog 2: Aurora's roads now come from one geography manifest, and we wrote the canon for what lives under the water. Not playable yet, but the map is starting to connect. Link in replies." },
      { kind: "social_post", channel: "bluesky", title: "Bluesky: devlog 2", body_md: "Devlog 2 is up. This week Aurora got its road corridors and harbours from a single manifest, plus the canon for submarines and naval work. Honest status: mostly foundations, some of it you will drive on soon." },
    ],
    tasks: [{ title: "Review and publish devlog 2", priority: 2 }],
  },
  "creatoros.content-crew": {
    goal: "Plan this week's CreatorOS content from the strategy doc and what happened across the divisions, and draft every post for Nico to review.",
    steps: [
      { member: "Strategist", label: "Choosing this week's posts" },
      { member: "Writer", label: "Writing each post for its platform" },
      { member: "Editor", label: "Editing for voice and accuracy" },
    ],
    summary: "Planned 4 posts: 2 build-in-public, 1 agents lesson, 1 OTHERLIFE",
    drafts: [
      {
        kind: "plan",
        channel: null,
        title: "Content plan: week of Monday, Oct 12",
        body_md:
          "| Day | Platform | Pillar | Angle |\n|---|---|---|---|\n| Mon | X | Build in public | My support agent triaged its first full week |\n| Wed | LinkedIn | Agents lesson | Why every agent action waits for my approval |\n| Thu | Bluesky | OTHERLIFE | Devlog 2: roads and harbours |\n| Fri | X | Build in public | What the city looked like this week |",
      },
      { kind: "social_post", channel: "x", title: "Mon x: the support agent's first week", body_md: "My support agent triaged 23 emails this week. It drafted 14 replies; I sent 12 and rewrote 2. The other 9 were spam or routed to billing. Nothing goes out without my click." },
      {
        kind: "social_post",
        channel: "linkedin",
        title: "Wed linkedin: every action waits for approval",
        body_md:
          "I run my companies with a handful of AI agents. The rule that makes it work: anything that spends money or contacts a customer waits in an approval queue, and runs exactly as I approved it, once.\n\nThis week that meant 2 refunds and 9 emails I checked in under five minutes a day.",
      },
    ],
    tasks: [{ title: "Review and schedule this week's posts", priority: 3 }],
  },
  "parlaylab.review-crew": {
    goal: "Write ParlayLab's weekly business review from its metrics and agent activity, and turn the top recommendations into tasks.",
    steps: [
      { member: "Analyst", label: "Measuring the week from ParlayLab's data" },
      { member: "Strategist", label: "Writing the review and recommendations" },
    ],
    summary: "Weekly review: MRR $4,236 (+3.1%), support inbox down 2 days, 2 recommendations",
    drafts: [
      {
        kind: "report",
        channel: null,
        title: "ParlayLab weekly review: week of Monday, Oct 12",
        body_md:
          "## Headline\nMRR **$4,236** (+3.1% week over week), 183 active subscriptions.\n\n## Billing and support\n- 3 failed payments, $57.00 due; 1 recovered on retry, 1 dunning email waiting for approval.\n- Support triaged 12 threads; the inbox was disconnected for 2 days (Gmail token expired).\n\n## Data gaps\nNo churn reasons recorded yet.\n\n## Recommendations\n1. Alert when the support inbox disconnects (effect: no silent gaps; metric: days without triage).\n2. Card-update reminder 3 days before renewal (effect: fewer failed payments; metric: failed_payments).",
      },
    ],
    tasks: [
      { title: "Add an alert when the support inbox disconnects", priority: 2 },
      { title: "Test a card-update reminder 3 days before renewal", priority: 3 },
    ],
  },
};

const CREW_IDS = Object.keys(CREW_SCRIPTS);

const RUN_SCRIPTS: Record<string, { goal: string; results: string[] }> = {
  "parlaylab.billing-01": {
    goal: "Review failed payments and past-due subscriptions",
    results: [
      "2 failed payments ($38.00 due): 1 dunning email queued, 1 already pending.",
      "No new failed payments since this morning; past-due total unchanged at $57.00.",
      "1 failed payment recovered on retry; recorded failed_payments = 2.",
    ],
  },
  "parlaylab.support-01": {
    goal: "Triage the support inbox and draft replies",
    results: [
      "Triaged 5 threads: 3 replies queued, 1 refund request routed to billing, 1 spam.",
      "Inbox clear: 2 how-to questions answered, replies waiting for approval.",
      "Triaged 3 threads: 1 bug logged for Nico with repro steps, 2 replies queued.",
    ],
  },
  "parlaylab.growth-01": {
    goal: "Refresh subscription metrics and the experiment backlog",
    results: ["MRR $4,236 (+0.6% WoW), 183 active subscriptions.", "MRR $4,251, 184 active; Pro monthly up 3 this week."],
  },
};

const DEMO_BRIEF = (when: Date) => `# Daily brief: ${when.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}

## Needs you
- **Refund $19.00 to sam@example.com**: duplicate charge on the Pro renewal (BILLING-01). Financial, waiting 2 h.
- **Dunning email to jordan@example.com**: second failed attempt, Stripe retries in 3 days.
- **Decide:** is AverageOutput the parent brand with OTHERLIFE as a product, or two divisions?

## What moved
- **ParlayLab:** MRR $4,210 (+3.1% WoW), 182 active subscriptions; 23 new and 4 cancellations this week.
- **ParlayLab support:** 5 threads triaged overnight, 3 replies queued.

## Stale or failing
- **SUPPORT-01** failed at 6:40: Gmail token expired. Reconnect the support inbox.

## Top 3 today
1. Clear the two approvals (2 minutes).
2. Reconnect the support inbox so SUPPORT-01 can run at 9:30.
3. Pick ParlayLab's first growth experiment from the backlog.

## Spend yesterday
$1.84 total: HQ $0.52, ParlayLab $1.32.`;

let nextEventId = 1;
const uuid = () => globalThis.crypto.randomUUID();
const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();
const pick = <T,>(items: readonly T[]) => items[Math.floor(Math.random() * items.length)]!;
const minutes = (n: number) => n * 60_000;

function makeEvent(division_id: string, agent_id: string | null, type: EventType, summary: string, level: Level = "info", agoMs = 0, payload: Record<string, unknown> = {}): EventRow {
  return { id: nextEventId++, ts: isoAgo(agoMs), division_id, agent_id, run_id: null, type, level, summary, payload };
}

function makeApproval(input: { agent: string; tier: ApprovalRow["tier"]; title: string; rationale: string; tool: string; args: Record<string, unknown>; amount?: number; agoMs: number }): ApprovalRow {
  const created = Date.now() - input.agoMs;
  return {
    id: uuid(),
    created_at: new Date(created).toISOString(),
    division_id: "parlaylab",
    agent_id: input.agent,
    run_id: null,
    tier: input.tier,
    title: input.title,
    rationale: input.rationale,
    action: { tool: input.tool, args: input.args },
    action_hash: uuid(),
    amount_cents: input.amount ?? null,
    currency: input.amount ? "usd" : null,
    status: "pending",
    decided_at: null,
    decided_note: null,
    expires_at: new Date(created + 72 * 3_600_000).toISOString(),
    executed_at: null,
    result: null,
    decided_by: null,
    notified_at: null,
  };
}

function initialState() {
  nextEventId = 1;
  const metrics: Record<string, Record<string, MetricValue>> = {
    parlaylab: {
      mrr: { value: 4210, unit: "usd", delta: 3.1 },
      active_subscriptions: { value: 182, unit: "count", delta: 5 },
      new_subscriptions_7d: { value: 23, unit: "count" },
      cancellations_7d: { value: 4, unit: "count", delta: -2 },
      failed_payments: { value: 3, unit: "count" },
    },
    creatoros: {
      followers: { value: 48_200, unit: "count", delta: 310 },
      views_7d: { value: 312_000, unit: "count", delta: 12_000 },
      engagement_rate: { value: 4.2, unit: "percent", delta: 0.3 },
    },
  };
  const divisions: DivisionRow[] = DIVISIONS.map((d) => ({
    id: d.id,
    name: d.name,
    kind: d.kind,
    status: d.status,
    summary: d.summary,
    context_md: d.contextMd,
    city_slot: d.slot,
    metrics: metrics[d.id] ?? {},
    created_at: isoAgo(minutes(60 * 24 * 7)),
  }));
  const agents: AgentRow[] = DEMO_AGENTS.map((a) => ({
    ...a,
    instructions: "",
    default_goal: null,
    state: a.id === "parlaylab.billing-01" ? "waiting_approval" : a.id === "parlaylab.support-01" ? "error" : "idle",
    last_checkin_at: isoAgo(minutes(a.runtime === "crewai" ? 60 * 26 : a.id === "hq.hq-01" ? 3 : 25)),
    daily_budget_usd: a.runtime === "crewai" ? 2 : a.model_tier === "reasoning" ? 3 : 1.5,
    enabled: true,
    created_at: isoAgo(minutes(60 * 24 * 7)),
  }));

  const approvals = [
    makeApproval({
      agent: "parlaylab.billing-01",
      tier: "financial",
      title: "Refund $19.00 to sam@example.com (pi_3QdemoA1, duplicate)",
      rationale: "Two identical $19.00 charges for the Pro renewal 41 seconds apart on Oct 9; the second is a duplicate.",
      tool: "stripe.issue_refund",
      args: { payment_intent: "pi_3QdemoA1", amount_cents: 1900, currency: "usd", reason: "duplicate", customer_email: "sam@example.com" },
      amount: 1900,
      agoMs: minutes(122),
    }),
    makeApproval({
      agent: "parlaylab.billing-01",
      tier: "external_effect",
      title: "Email jordan@example.com: Your ParlayLab payment didn't go through",
      rationale: "Second failed attempt on invoice in_1Qdemo (card declined); Stripe retries again in 3 days.",
      tool: "email.send",
      args: {
        to: "jordan@example.com",
        subject: "Your ParlayLab payment didn't go through",
        body_text:
          "Hi Jordan,\n\nYour ParlayLab Pro renewal ($19.00) didn't go through. You can update your card here: https://invoice.stripe.com/i/demo\n\nIf anything looks off, just reply and we'll help.\n\nParlayLab",
      },
      agoMs: minutes(47),
    }),
  ];

  const events: EventRow[] = [
    makeEvent("parlaylab", "parlaylab.growth-01", "run.started", "Refresh subscription metrics and the experiment backlog", "info", minutes(95)),
    makeEvent("parlaylab", "parlaylab.growth-01", "metric.updated", "MRR $4,210 (+3.1% WoW), 182 active", "info", minutes(93)),
    makeEvent("parlaylab", "parlaylab.growth-01", "task.created", "New task: Experiment: annual plan nudge at checkout", "info", minutes(92)),
    makeEvent("parlaylab", "parlaylab.growth-01", "run.succeeded", "MRR $4,210 (+3.1% WoW), 182 active subscriptions.", "success", minutes(91)),
    makeEvent("parlaylab", "parlaylab.billing-01", "run.started", "Review failed payments and past-due subscriptions", "info", minutes(125)),
    makeEvent("parlaylab", "parlaylab.billing-01", "approval.requested", approvals[0]!.title, "warning", minutes(122)),
    makeEvent("parlaylab", "parlaylab.billing-01", "run.succeeded", "3 failed payments ($57.00 due): 1 refund proposed, 1 dunning email pending.", "success", minutes(120)),
    makeEvent("parlaylab", "parlaylab.billing-01", "approval.requested", approvals[1]!.title, "warning", minutes(47)),
    makeEvent("parlaylab", "parlaylab.support-01", "run.started", "Triage the support inbox and draft replies", "info", minutes(26)),
    makeEvent("parlaylab", "parlaylab.support-01", "run.failed", "Failed: Gmail 401: invalid_grant (token expired)", "error", minutes(25)),
    makeEvent("creatoros", null, "metric.updated", "Followers 48.2K (+310 today)", "info", minutes(18)),
    makeEvent("hq", "hq.hq-01", "run.started", "Write and publish today's daily brief for Nico", "info", minutes(6)),
    makeEvent("hq", "hq.hq-01", "task.created", "New task: Decide AverageOutput / OTHERLIFE division structure", "info", minutes(4)),
    makeEvent("hq", "hq.hq-01", "brief.published", "2 approvals waiting, SUPPORT-01 needs its inbox reconnected", "success", minutes(3)),
    makeEvent("hq", "hq.hq-01", "run.succeeded", "Brief published: 2 approvals waiting, 1 failing agent.", "success", minutes(3)),
  ].sort((a, b) => b.id - a.id);

  const tasks: TaskRow[] = [
    { title: "Decide AverageOutput / OTHERLIFE division structure", division_id: "hq", priority: 1, owner: "nico" },
    { title: "Reconnect the ParlayLab support inbox (Gmail token expired)", division_id: "parlaylab", priority: 1, owner: "nico" },
    { title: "Experiment: annual plan nudge at checkout", division_id: "parlaylab", priority: 2, owner: "nico" },
    { title: "Pick ParlayLab's first 3 agent jobs to keep", division_id: "hq", priority: 3, owner: "nico" },
  ].map((t, i) => ({
    id: uuid(),
    notes: null,
    status: "open",
    due_at: null,
    source: "hq.hq-01",
    created_at: isoAgo(minutes(10 + i)),
    updated_at: isoAgo(minutes(10 + i)),
    ...t,
  })) as TaskRow[];

  const draft = (agent_id: string, division_id: string, d: DemoDraft, agoMs: number): DraftRow => ({
    id: uuid(),
    created_at: isoAgo(agoMs),
    division_id,
    agent_id,
    run_id: null,
    status: "draft",
    updated_at: isoAgo(agoMs),
    reviewed_at: null,
    reviewed_by: null,
    original_body_md: null,
    published_url: null,
    ...d,
  });
  // What the crews handed back last week, so the drafts lists are not empty on load.
  const drafts: DraftRow[] = [
    draft("averageoutput.devlog-crew", "averageoutput", {
      kind: "devlog",
      channel: "blog",
      title: "OTHERLIFE devlog 1: a city that hires the people who live in it",
      body_md:
        "# OTHERLIFE devlog 1: a city that hires the people who live in it\n\nThe first devlog. This week a city in Aurora learned to employ its own residents: businesses can now hire people who live nearby, and those jobs persist when you log off and come back.\n\n## The map\nWe also wrote down where everything in Aurora goes, from coastlines to mountain ranges, as a specification the world builder can read.\n\n## What's next\nMaking more of that map something you can actually walk and drive through.",
    }, minutes(60 * 26)),
    draft("averageoutput.devlog-crew", "averageoutput", { kind: "social_post", channel: "x", title: "X: devlog 1", body_md: "OTHERLIFE devlog 1: cities in Aurora can now hire the people who live in them, and the jobs persist across sessions. First devlog of many. Link in replies." }, minutes(60 * 26)),
    draft("parlaylab.review-crew", "parlaylab", {
      kind: "report",
      channel: null,
      title: "ParlayLab weekly review: week of Monday, Oct 5",
      body_md: "## Headline\nMRR **$4,084** (+1.2%), 177 active subscriptions.\n\n## Recommendations\n1. Ask cancelling customers for a reason (metric: churn reasons recorded).",
    }, minutes(60 * 24 * 4)),
  ];

  const brief: BriefRow = { id: uuid(), created_at: isoAgo(minutes(3)), body_md: DEMO_BRIEF(new Date()), run_id: null, notified_at: null };
  // Knowledge documents Nico wrote (and one an agent saved), so the Knowledge sections are not empty.
  const doc = (division_id: string, slug: string, title: string, body_md: string, tags: string[], agoMs: number, updated_by = "owner", version = 1): DocumentRow => ({
    id: uuid(),
    division_id,
    slug,
    title,
    body_md,
    tags,
    archived: false,
    version,
    created_at: isoAgo(agoMs * 3),
    updated_at: isoAgo(agoMs),
    updated_by,
  });
  const documents: DocumentRow[] = [
    doc("hq", "priorities", "Q4 priorities", "1. **FedOps first:** deploy it, enter the real company profile, connect it to Agent City.\n2. Keep OTHERLIFE devlogs weekly.\n3. ParlayLab and GalleySwap launch prep before any of their agents.", ["planning"], minutes(60 * 20), "owner", 3),
    doc("creatoros", "content-strategy", "Content strategy", "- **Audience:** founders building with AI agents, and OTHERLIFE players.\n- **Pillars:** building in public, lessons from running agents, OTHERLIFE development.\n- **Never:** customer data, revenue Nico has not cleared, betting advice.", ["strategy", "voice"], minutes(60 * 30)),
    doc("averageoutput", "devlog-lessons", "Devlog lessons", "Posts that show a screenshot of the city get about twice the replies. Lead with what a player can see.", ["devlog"], minutes(60 * 50), "averageoutput.devlog-crew", 2),
  ];
  return { divisions, agents, approvals, events, tasks, drafts, documents, brief, settings: { agents_paused: false, trigger_api_url: "", updated_at: isoAgo(0) } };
}

// ----------------------------------------------------------------- simulation

let timers: ReturnType<typeof setTimeout>[] = [];
let running = false;

function later(ms: number, fn: () => void) {
  const id = setTimeout(() => {
    timers = timers.filter((t) => t !== id);
    if (running) fn();
  }, ms);
  timers.push(id);
}

function emit(division_id: string, agent_id: string | null, type: EventType, summary: string, level: Level = "info", payload: Record<string, unknown> = {}) {
  useCity.getState().pushEvent(makeEvent(division_id, agent_id, type, summary, level, 0, payload));
}

function setAgent(id: string, patch: Partial<AgentRow>) {
  const agent = useCity.getState().agents.find((a) => a.id === id);
  if (agent) useCity.getState().upsertAgent({ ...agent, last_checkin_at: new Date().toISOString(), ...patch });
}

function paused() {
  return Boolean(useCity.getState().settings?.agents_paused);
}

function bumpMetrics(divisionId: string, update: (m: Record<string, MetricValue>) => Record<string, MetricValue>, summary: string, agentId: string | null) {
  const division = useCity.getState().divisions.find((d) => d.id === divisionId);
  if (!division) return;
  useCity.getState().upsertDivision({ ...division, metrics: { ...division.metrics, ...update(division.metrics) } });
  emit(divisionId, agentId, "metric.updated", summary);
}

function simulateRun(agentId: string) {
  const state = useCity.getState();
  const agent = state.agents.find((a) => a.id === agentId);
  if (!agent || agent.state === "working" || paused()) return;
  const script = RUN_SCRIPTS[agentId];
  const goal = script?.goal ?? "Write and publish today's daily brief for Nico";
  setAgent(agentId, { state: "working" });
  emit(agent.division_id, agentId, "run.started", goal);

  later(2_500 + Math.random() * 2_500, () => {
    if (agentId === "parlaylab.support-01") emit(agent.division_id, agentId, "run.progress", "Classified 4 threads with the fast model");
  });

  later(6_000 + Math.random() * 7_000, () => {
    if (paused()) return;
    if (Math.random() < 0.06) {
      setAgent(agentId, { state: "error" });
      emit(agent.division_id, agentId, "run.failed", "Failed: Stripe API 503 (service unavailable)", "error");
      return;
    }
    if (agentId === "parlaylab.growth-01") {
      bumpMetrics(
        "parlaylab",
        (m) => {
          const mrr = (m.mrr?.value ?? 4210) + Math.round(5 + Math.random() * 30);
          const active = (m.active_subscriptions?.value ?? 182) + (Math.random() < 0.6 ? 1 : 0);
          return { mrr: { value: mrr, unit: "usd", delta: 3.2 }, active_subscriptions: { value: active, unit: "count", delta: 6 } };
        },
        "MRR updated from Stripe",
        agentId,
      );
    }
    let queued = false;
    // Keep the demo queue realistic: new requests only while fewer than four wait on you.
    const waitingCount = useCity.getState().approvals.filter((a) => a.status === "pending").length;
    if ((agentId === "parlaylab.billing-01" || agentId === "parlaylab.support-01") && waitingCount < 4 && Math.random() < 0.35) {
      const who = pick(["alex", "riley", "casey", "morgan", "jamie"]);
      const approval = makeApproval({
        agent: agentId,
        tier: "external_effect",
        title: `Email ${who}@example.com: ${agentId.includes("billing") ? "Your ParlayLab payment didn't go through" : "Re: How do parlay odds update?"}`,
        rationale: agentId.includes("billing") ? "First failed renewal attempt; card expired last month." : "How-to question; answer is in the odds FAQ.",
        tool: "email.send",
        args: { to: `${who}@example.com`, subject: "Re: your question", body_text: "Hi! Thanks for reaching out..." },
        agoMs: 0,
      });
      useCity.getState().upsertApproval(approval);
      emit("parlaylab", agentId, "approval.requested", approval.title, "warning", { approval_id: approval.id });
      queued = true;
    }
    const waiting = useCity.getState().approvals.some((a) => a.agent_id === agentId && a.status === "pending");
    setAgent(agentId, { state: waiting ? "waiting_approval" : "idle" });
    emit(agent.division_id, agentId, "run.succeeded", pick(script?.results ?? ["Run complete."]) + (queued ? " (1 approval queued)" : ""), "success");
  });
}

function simulateBrief() {
  if (paused()) return;
  setAgent("hq.hq-01", { state: "working" });
  emit("hq", "hq.hq-01", "run.started", "Write and publish today's daily brief for Nico");
  later(7_000, () => {
    const brief: BriefRow = { id: uuid(), created_at: new Date().toISOString(), body_md: DEMO_BRIEF(new Date()), run_id: null, notified_at: null };
    useCity.getState().setBrief(brief);
    const pending = useCity.getState().approvals.filter((a) => a.status === "pending").length;
    emit("hq", "hq.hq-01", "brief.published", `${pending} approvals waiting; ParlayLab MRR steady`, "success");
    setAgent("hq.hq-01", { state: "idle" });
    emit("hq", "hq.hq-01", "run.succeeded", "Brief published.", "success");
  });
}

/** A crew run: each member's task in turn (the tower lights up), then its drafts and tasks. */
function simulateCrew(crewId: string) {
  const agent = useCity.getState().agents.find((a) => a.id === crewId);
  const script = CREW_SCRIPTS[crewId];
  if (!agent || !script || agent.state === "working" || paused()) return;
  const division = agent.division_id;
  const steps = script.steps.length;
  setAgent(crewId, { state: "working" });
  emit(division, crewId, "run.started", script.goal);

  script.steps.forEach((step, i) => {
    later(1_500 + i * 6_000, () => {
      if (paused()) return;
      setAgent(crewId, { state: "working" });
      emit(division, crewId, "run.progress", `${step.member}: ${step.label} (${i + 1}/${steps})`, "info", { member: step.member, step: i + 1, steps });
    });
  });

  later(1_500 + steps * 6_000, () => {
    if (paused()) return;
    for (const d of script.drafts) {
      const at = new Date().toISOString();
      const row: DraftRow = { id: uuid(), created_at: at, updated_at: at, division_id: division, agent_id: crewId, run_id: null, status: "draft", reviewed_at: null, reviewed_by: null, original_body_md: null, published_url: null, ...d };
      useCity.getState().upsertDraft(row);
      emit(division, crewId, "run.progress", `Draft ready: ${d.title}`.slice(0, 200), "info", { draft_id: row.id, kind: d.kind, channel: d.channel });
    }
    for (const t of script.tasks) {
      const now = new Date().toISOString();
      useCity.getState().upsertTask({ id: uuid(), division_id: division, title: t.title, notes: null, owner: "nico", status: "open", priority: t.priority, due_at: null, source: crewId, created_at: now, updated_at: now });
      emit(division, crewId, "task.created", `New task: ${t.title}`.slice(0, 200));
    }
    setAgent(crewId, { state: "idle" });
    emit(division, crewId, "run.succeeded", script.summary, "success");
  });
}

function loop() {
  if (!paused()) {
    const candidates = ["parlaylab.billing-01", "parlaylab.support-01", "parlaylab.growth-01"];
    simulateRun(pick(candidates));
    if (Math.random() < 0.12) simulateCrew(pick(CREW_IDS));
    if (Math.random() < 0.25) {
      const followers = useCity.getState().divisions.find((d) => d.id === "creatoros")?.metrics.followers;
      const gain = Math.round(20 + Math.random() * 90);
      const value = (followers?.value ?? 48_200) + gain;
      const today = (followers?.delta ?? 310) + gain;
      bumpMetrics(
        "creatoros",
        () => ({ followers: { value, unit: "count", delta: today } }),
        `Followers ${value.toLocaleString("en-US")} (+${today} today)`,
        null,
      );
    }
  }
  later(7_000 + Math.random() * 6_000, loop);
}

export function startDemo(): () => void {
  const store = useCity.getState();
  store.hydrate(initialState());
  store.setConnection("demo");
  running = true;
  later(2_000, loop);
  // Start one crew early so the city shows a crew at work within seconds.
  later(9_000, () => simulateCrew("averageoutput.devlog-crew"));
  later(70_000, function briefLoop() {
    simulateBrief();
    later(120_000, briefLoop);
  });
  return () => {
    running = false;
    timers.forEach(clearTimeout);
    timers = [];
  };
}

// ------------------------------------------------------- demo-side writes

/** Demo stand-in for the drafts update: same rules as the database trigger (keeps the original text). */
export function demoReviewDraft(draftId: string, review: DraftReview) {
  const draft = useCity.getState().drafts.find((d) => d.id === draftId);
  if (!draft) return { ok: false as const, error: "This draft no longer exists." };
  const now = new Date().toISOString();
  const bodyChanged = review.body_md !== undefined && review.body_md !== draft.body_md;
  useCity.getState().upsertDraft({
    ...draft,
    ...review,
    updated_at: now,
    reviewed_at: now,
    original_body_md: bodyChanged && draft.original_body_md === null ? draft.body_md : draft.original_body_md,
  });
  return { ok: true as const };
}

/** Demo stand-in for inserting a document from the city (version 1, written by the owner). */
export function demoCreateDocument(input: DocumentInput) {
  const state = useCity.getState();
  if (state.documents.some((d) => d.division_id === input.division_id && d.slug === input.slug)) {
    return { ok: false as const, error: `A document called "${input.slug}" already exists here.` };
  }
  const now = new Date().toISOString();
  state.upsertDocument({ ...input, id: uuid(), archived: false, version: 1, created_at: now, updated_at: now, updated_by: "owner" });
  return { ok: true as const };
}

/** Demo stand-in for editing a document: same rules as the database trigger (version bump on content changes). */
export function demoEditDocument(documentId: string, edit: DocumentEdit) {
  const doc = useCity.getState().documents.find((d) => d.id === documentId);
  if (!doc) return { ok: false as const, error: "This document no longer exists." };
  const contentChanged =
    (edit.title !== undefined && edit.title !== doc.title) ||
    (edit.body_md !== undefined && edit.body_md !== doc.body_md) ||
    (edit.tags !== undefined && edit.tags.join("\u0000") !== doc.tags.join("\u0000"));
  useCity.getState().upsertDocument({ ...doc, ...edit, version: contentChanged ? doc.version + 1 : doc.version, updated_at: new Date().toISOString(), updated_by: "owner" });
  return { ok: true as const };
}

export function demoDecide(approvalId: string, decision: "approved" | "rejected", note: string | null) {
  const approval = useCity.getState().approvals.find((a) => a.id === approvalId);
  if (!approval || approval.status !== "pending") return { ok: false as const, error: "Already decided or expired." };
  const decided: ApprovalRow = { ...approval, status: decision, decided_at: new Date().toISOString(), decided_note: note };
  useCity.getState().upsertApproval(decided);
  emit(approval.division_id, approval.agent_id, "approval.decided", `${decision === "approved" ? "Approved" : "Rejected"}: ${approval.title}`.slice(0, 200), decision === "approved" ? "success" : "info", { approval_id: approval.id, status: decision });
  const stillPending = useCity.getState().approvals.some((a) => a.agent_id === approval.agent_id && a.status === "pending");
  const agent = useCity.getState().agents.find((a) => a.id === approval.agent_id);
  if (agent?.state === "waiting_approval" && !stillPending) setAgent(agent.id, { state: "idle" });

  if (decision === "approved") {
    later(800, () => useCity.getState().upsertApproval({ ...decided, status: "executing" }));
    later(2_000, () => {
      const result =
        approval.action.tool === "stripe.issue_refund"
          ? { refund_id: "re_demo_1", status: "succeeded", amount: formatMinorUnits(approval.amount_cents ?? 0, approval.currency ?? "usd") }
          : { sent: true, provider: "resend", message_id: "em_demo_1" };
      useCity.getState().upsertApproval({ ...decided, status: "executed", executed_at: new Date().toISOString(), result });
      emit(approval.division_id, approval.agent_id, "action.executed", `Done: ${approval.title}`.slice(0, 200), "success", { approval_id: approval.id, result });
    });
  }
  return { ok: true as const };
}

export function demoSetPaused(pausedNow: boolean) {
  const state = useCity.getState();
  state.setSettings({ agents_paused: pausedNow, trigger_api_url: "", updated_at: new Date().toISOString() });
  if (pausedNow) {
    for (const agent of state.agents) if (agent.state === "working") setAgent(agent.id, { state: "idle" });
  }
}
