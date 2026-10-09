import { formatMinorUnits } from "@agent-city/core";
import Stripe from "stripe";
import { z } from "zod";
import { defineTool, ToolError, type ToolContext } from "../types";

// Stripe tools for ParlayLab. Each agent uses its own restricted key (spec §7.4)
// holding only the resources it needs, e.g. BILLING-01: read subscriptions,
// invoices, customers, charges + write refunds; GROWTH-01: read subscriptions,
// prices, products.

const clients = new Map<string, Stripe>();

export function stripeClient(ctx: ToolContext): Stripe {
  if (!ctx.secret) {
    throw new ToolError("missing_credential", `No Stripe key for ${ctx.agent.id}. Store it in Vault as agent:${ctx.agent.id}:stripe.`);
  }
  let client = clients.get(ctx.secret);
  if (!client) {
    client = new Stripe(ctx.secret, { maxNetworkRetries: 2, timeout: 30_000, appInfo: { name: "agent-city" } });
    clients.set(ctx.secret, client);
  }
  return client;
}

const isoFromUnix = (seconds: number | null | undefined) => (seconds ? new Date(seconds * 1000).toISOString() : null);

function customerSummary(customer: string | Stripe.Customer | Stripe.DeletedCustomer | null) {
  if (!customer) return null;
  if (typeof customer === "string") return { id: customer };
  if ("deleted" in customer && customer.deleted) return { id: customer.id, deleted: true };
  const c = customer as Stripe.Customer;
  return { id: c.id, email: c.email, name: c.name };
}

/** Normalize a recurring price to a monthly amount in minor units. */
export function monthlyAmount(price: Stripe.Price, quantity: number): number {
  const unit = price.unit_amount ?? 0;
  const recurring = price.recurring;
  if (!recurring) return 0;
  const every = recurring.interval_count || 1;
  const perInterval = unit * quantity;
  switch (recurring.interval) {
    case "day":
      return (perInterval * 365) / 12 / every;
    case "week":
      return (perInterval * 52) / 12 / every;
    case "month":
      return perInterval / every;
    case "year":
      return perInterval / 12 / every;
    default:
      return 0;
  }
}

function tierName(price: Stripe.Price): string {
  const product = price.product;
  const productName = typeof product === "object" && product && "name" in product ? product.name : null;
  return price.nickname ?? productName ?? price.lookup_key ?? price.id;
}

function subscriptionSummary(sub: Stripe.Subscription) {
  const item = sub.items.data[0];
  return {
    id: sub.id,
    status: sub.status,
    customer: customerSummary(sub.customer),
    tier: item ? tierName(item.price) : null,
    amount: item ? formatMinorUnits((item.price.unit_amount ?? 0) * (item.quantity ?? 1), item.price.currency) : null,
    interval: item?.price.recurring?.interval ?? null,
    current_period_end: isoFromUnix(item?.current_period_end),
    cancel_at_period_end: sub.cancel_at_period_end,
    canceled_at: isoFromUnix(sub.canceled_at),
    created: isoFromUnix(sub.created),
  };
}

export const stripeListSubscriptions = defineTool({
  name: "stripe.list_subscriptions",
  tier: "read",
  integration: "stripe",
  description: "List ParlayLab Stripe subscriptions (newest first) with customer, tier, amount and period end.",
  schema: z.object({
    status: z.enum(["active", "past_due", "unpaid", "canceled", "trialing", "incomplete", "all"]).optional(),
    created_within_days: z.number().int().min(1).max(365).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  describe: (a) => `List ${a.status ?? "active"} subscriptions`,
  async execute(a, ctx) {
    const stripe = stripeClient(ctx);
    const params: Stripe.SubscriptionListParams = {
      status: a.status ?? "active",
      limit: a.limit ?? 50,
      expand: ["data.customer"],
    };
    if (a.created_within_days) {
      params.created = { gte: Math.floor(ctx.now().getTime() / 1000) - a.created_within_days * 86_400 };
    }
    const page = await stripe.subscriptions.list(params);
    return { has_more: page.has_more, subscriptions: page.data.map(subscriptionSummary) };
  },
});

export const stripeListFailedPayments = defineTool({
  name: "stripe.list_failed_payments",
  tier: "read",
  integration: "stripe",
  description:
    "Open invoices whose payment attempts failed (dunning candidates), with customer, amount due, attempt count and next retry.",
  schema: z.object({
    days: z.number().int().min(1).max(90).optional().describe("Invoices created in the last N days, default 30"),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  describe: (a) => `List failed payments (last ${a.days ?? 30} days)`,
  async execute(a, ctx) {
    const stripe = stripeClient(ctx);
    const since = Math.floor(ctx.now().getTime() / 1000) - (a.days ?? 30) * 86_400;
    const page = await stripe.invoices.list({
      status: "open",
      created: { gte: since },
      limit: a.limit ?? 50,
      expand: ["data.customer"],
    });
    const failed = page.data.filter((inv) => inv.attempted && inv.attempt_count > 0);
    return {
      failed_invoices: failed.map((inv) => ({
        invoice_id: inv.id,
        customer: customerSummary(inv.customer) ?? { email: inv.customer_email, name: inv.customer_name },
        customer_email: inv.customer_email,
        amount_due: formatMinorUnits(inv.amount_due, inv.currency),
        amount_due_cents: inv.amount_due,
        currency: inv.currency,
        attempt_count: inv.attempt_count,
        next_payment_attempt: isoFromUnix(inv.next_payment_attempt),
        hosted_invoice_url: inv.hosted_invoice_url ?? null,
        created: isoFromUnix(inv.created),
      })),
    };
  },
});

export const stripeFindCustomer = defineTool({
  name: "stripe.find_customer",
  tier: "read",
  integration: "stripe",
  description:
    "Look up a customer by email: their subscriptions and last charges (charge id, payment intent, amount, refunded). Use this before proposing a refund.",
  schema: z.object({ email: z.email() }),
  describe: (a) => `Find Stripe customer ${a.email}`,
  async execute(a, ctx) {
    const stripe = stripeClient(ctx);
    const customers = await stripe.customers.list({ email: a.email, limit: 3 });
    const results = [];
    for (const customer of customers.data) {
      const [subs, charges] = await Promise.all([
        stripe.subscriptions.list({ customer: customer.id, status: "all", limit: 10 }),
        stripe.charges.list({ customer: customer.id, limit: 10 }),
      ]);
      results.push({
        customer: { id: customer.id, email: customer.email, name: customer.name, created: isoFromUnix(customer.created) },
        subscriptions: subs.data.map(subscriptionSummary),
        charges: charges.data.map((ch) => ({
          charge_id: ch.id,
          payment_intent: typeof ch.payment_intent === "string" ? ch.payment_intent : (ch.payment_intent?.id ?? null),
          amount: formatMinorUnits(ch.amount, ch.currency),
          amount_cents: ch.amount,
          amount_refunded_cents: ch.amount_refunded,
          currency: ch.currency,
          status: ch.status,
          refunded: ch.refunded,
          description: ch.description,
          created: isoFromUnix(ch.created),
        })),
      });
    }
    return { matches: results.length, results };
  },
});

export const stripeGetMetrics = defineTool({
  name: "stripe.get_metrics",
  tier: "read",
  integration: "stripe",
  description:
    "Compute ParlayLab subscription metrics from Stripe: gross MRR (before discounts), active subscriptions by tier, new subscriptions and cancellations over the last N days.",
  schema: z.object({
    days: z.number().int().min(1).max(90).optional().describe("Window for new and cancelled subscriptions, default 7"),
  }),
  describe: (a) => `Compute Stripe metrics (${a.days ?? 7}d)`,
  async execute(a, ctx) {
    const stripe = stripeClient(ctx);
    const days = a.days ?? 7;
    const since = Math.floor(ctx.now().getTime() / 1000) - days * 86_400;
    const CAP = 5_000;

    const prices = await stripe.prices.list({ limit: 100, expand: ["data.product"] }).autoPagingToArray({ limit: 500 });
    const priceById = new Map(prices.map((p) => [p.id, p]));

    let mrrCents = 0;
    let active = 0;
    let currency = "usd";
    const byTier = new Map<string, { subscriptions: number; mrr_cents: number }>();
    for await (const sub of stripe.subscriptions.list({ status: "active", limit: 100 })) {
      active++;
      for (const item of sub.items.data) {
        const price = priceById.get(item.price.id) ?? item.price;
        currency = price.currency;
        const monthly = monthlyAmount(price, item.quantity ?? 1);
        mrrCents += monthly;
        const tier = tierName(price);
        const entry = byTier.get(tier) ?? { subscriptions: 0, mrr_cents: 0 };
        entry.subscriptions += 1;
        entry.mrr_cents += monthly;
        byTier.set(tier, entry);
      }
      if (active >= CAP) break;
    }

    let newSubs = 0;
    for await (const _sub of stripe.subscriptions.list({ status: "all", created: { gte: since }, limit: 100 })) {
      newSubs++;
      if (newSubs >= CAP) break;
    }

    let cancellations = 0;
    for await (const sub of stripe.subscriptions.list({ status: "canceled", limit: 100 })) {
      if ((sub.ended_at ?? sub.canceled_at ?? 0) >= since) cancellations++;
      if ((sub.canceled_at ?? 0) < since - 90 * 86_400) break; // list is newest-created first; stop well past the window
    }

    return {
      as_of: ctx.now().toISOString(),
      currency,
      gross_mrr: formatMinorUnits(Math.round(mrrCents), currency),
      gross_mrr_cents: Math.round(mrrCents),
      active_subscriptions: active,
      truncated: active >= CAP,
      by_tier: [...byTier.entries()].map(([tier, v]) => ({
        tier,
        subscriptions: v.subscriptions,
        mrr: formatMinorUnits(Math.round(v.mrr_cents), currency),
      })),
      window_days: days,
      new_subscriptions: newSubs,
      cancellations,
    };
  },
});

/** Refunds above this need a human to do them in the Stripe dashboard. */
export const REFUND_HARD_LIMIT_CENTS = 50_000;

export const stripeIssueRefund = defineTool({
  name: "stripe.issue_refund",
  tier: "financial",
  integration: "stripe",
  description: `Propose a refund on a charge or payment intent. Financial: this only queues an approval for Nico showing the exact amount; it never executes immediately. Look up the charge with stripe.find_customer first. Hard limit ${formatMinorUnits(REFUND_HARD_LIMIT_CENTS)}.`,
  schema: z
    .object({
      payment_intent: z.string().startsWith("pi_").optional(),
      charge: z.string().startsWith("ch_").optional(),
      amount_cents: z.number().int().positive().max(REFUND_HARD_LIMIT_CENTS),
      currency: z.string().length(3).toLowerCase().default("usd"),
      reason: z.enum(["duplicate", "fraudulent", "requested_by_customer"]).optional(),
      customer_email: z.email().optional().describe("For the approval card"),
    })
    .refine((a) => Boolean(a.payment_intent) !== Boolean(a.charge), "Provide exactly one of payment_intent or charge"),
  describe: (a) =>
    `Refund ${formatMinorUnits(a.amount_cents, a.currency)}${a.customer_email ? ` to ${a.customer_email}` : ""} (${a.payment_intent ?? a.charge}${a.reason ? `, ${a.reason.replaceAll("_", " ")}` : ""})`,
  amount: (a) => ({ amount_cents: a.amount_cents, currency: a.currency }),
  async execute(a, ctx) {
    const stripe = stripeClient(ctx);
    const refund = await stripe.refunds.create(
      {
        payment_intent: a.payment_intent,
        charge: a.charge,
        amount: a.amount_cents,
        reason: a.reason,
        metadata: { approval_id: ctx.idempotencyKey ?? "", agent_id: ctx.agent.id },
      },
      ctx.idempotencyKey ? { idempotencyKey: `refund:${ctx.idempotencyKey}` } : undefined,
    );
    return {
      refund_id: refund.id,
      status: refund.status,
      amount: formatMinorUnits(refund.amount, refund.currency),
    };
  },
});

export const STRIPE_TOOLS = [
  stripeListSubscriptions,
  stripeListFailedPayments,
  stripeFindCustomer,
  stripeGetMetrics,
  stripeIssueRefund,
];
