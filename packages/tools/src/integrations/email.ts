import { z } from "zod";
import { defineTool, ToolError, type ToolContext } from "../types";
import { gmailAccessToken, parseGmailCredential } from "./gmail";

// Email: drafting is an internal write; sending is an external effect that
// always goes through the approval queue and executes the stored message
// verbatim (spec §7.3).
//
// The agent's scoped `email` credential selects the provider:
//   * a Resend API key ("re_...")                         -> Resend
//   * Gmail OAuth JSON {"provider":"gmail", client_id, client_secret, refresh_token}
//                                                         -> Gmail API (keeps support replies in-thread)

const Address = z.email().max(254);

export const emailDraft = defineTool({
  name: "email.draft",
  tier: "internal_write",
  integration: "internal",
  description:
    "Save an email draft for review. Drafts are never sent. To send, call email.send with the exact final content (that queues an approval).",
  schema: z.object({
    to: Address,
    subject: z.string().min(1).max(200),
    body_text: z.string().min(1).max(20_000),
    thread_id: z.string().max(200).optional().describe("Gmail thread id when replying to a support thread"),
    in_reply_to: z.string().max(500).optional().describe("Message-ID header of the message being replied to"),
  }),
  describe: (a) => `Draft email to ${a.to}: ${a.subject}`,
  async execute(a, ctx) {
    const draft = await ctx.repo.createEmailDraft({
      division_id: ctx.agent.division_id,
      agent_id: ctx.agent.id,
      run_id: ctx.runId,
      to_addr: a.to,
      subject: a.subject,
      body_text: a.body_text,
      thread_id: a.thread_id ?? null,
      in_reply_to: a.in_reply_to ?? null,
    });
    return { draft_id: draft.id, status: "draft" };
  },
});

const EmailSendSchema = z.object({
  to: Address,
  subject: z.string().min(1).max(200),
  body_text: z.string().min(1).max(20_000),
  draft_id: z.uuid().optional(),
  thread_id: z.string().max(200).optional(),
  in_reply_to: z.string().max(500).optional(),
});
type SendArgs = z.output<typeof EmailSendSchema>;

export const emailSend = defineTool({
  name: "email.send",
  tier: "external_effect",
  integration: "email",
  description:
    "Send an email to a customer or contact. External effect: this only queues an approval for Nico with the exact message; if approved it is sent exactly as written. Write the complete final text. Pass draft_id if it came from email.draft.",
  schema: EmailSendSchema,
  describe: (a) => `Email ${a.to}: ${a.subject}`,
  async execute(a, ctx): Promise<Record<string, unknown>> {
    if (!ctx.secret) {
      throw new ToolError("missing_credential", `No email credential for ${ctx.agent.id}. Store it in Vault as agent:${ctx.agent.id}:email.`);
    }
    const gmail = parseGmailCredential(ctx.secret);
    const result = gmail ? await sendWithGmail(a, ctx, gmail) : await sendWithResend(a, ctx, ctx.secret);
    if (a.draft_id) await ctx.repo.setEmailDraftStatus(a.draft_id, "sent");
    return { sent: true, ...result };
  },
});

function fromAddress(ctx: ToolContext): string {
  const key = `EMAIL_FROM_${ctx.agent.division_id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  const from = process.env[key] ?? process.env.EMAIL_FROM;
  if (!from) throw new ToolError("missing_config", `Set ${key} or EMAIL_FROM, e.g. "ParlayLab <support@example.com>".`);
  return from;
}

async function sendWithResend(a: SendArgs, ctx: ToolContext, apiKey: string) {
  const fetchFn = ctx.services.fetch ?? fetch;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  if (ctx.idempotencyKey) headers["Idempotency-Key"] = `email:${ctx.idempotencyKey}`;
  const response = await fetchFn("https://api.resend.com/emails", {
    method: "POST",
    headers,
    body: JSON.stringify({
      from: fromAddress(ctx),
      to: [a.to],
      subject: a.subject,
      text: a.body_text,
      headers: a.in_reply_to ? { "In-Reply-To": a.in_reply_to, References: a.in_reply_to } : undefined,
    }),
  });
  const body = (await response.json().catch(() => ({}))) as { id?: string; message?: string };
  if (!response.ok) throw new ToolError("send_failed", `Resend ${response.status}: ${body.message ?? "error"}`);
  return { provider: "resend", message_id: body.id ?? null };
}

function base64Url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** RFC 2822 message. Subject is RFC 2047 encoded so non-ASCII survives. */
export function buildRfc2822(a: { to: string; subject: string; body_text: string; in_reply_to?: string }, from?: string): string {
  const subject = /^[\x20-\x7e]*$/.test(a.subject) ? a.subject : `=?UTF-8?B?${Buffer.from(a.subject, "utf8").toString("base64")}?=`;
  const lines = [
    ...(from ? [`From: ${from}`] : []),
    `To: ${a.to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
  ];
  if (a.in_reply_to) lines.push(`In-Reply-To: ${a.in_reply_to}`, `References: ${a.in_reply_to}`);
  return `${lines.join("\r\n")}\r\n\r\n${a.body_text.replace(/\r?\n/g, "\r\n")}`;
}

async function sendWithGmail(a: SendArgs, ctx: ToolContext, credential: NonNullable<ReturnType<typeof parseGmailCredential>>) {
  const fetchFn = ctx.services.fetch ?? fetch;
  // Gmail has no idempotency keys. Execution is already guarded by the approval's
  // single claim (approved -> executing), so a retry never reaches this call.
  const token = await gmailAccessToken(credential, fetchFn);
  const response = await fetchFn("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: base64Url(buildRfc2822(a)), threadId: a.thread_id }),
  });
  const body = (await response.json().catch(() => ({}))) as { id?: string; threadId?: string; error?: { message?: string } };
  if (!response.ok) throw new ToolError("send_failed", `Gmail ${response.status}: ${body.error?.message ?? "error"}`);
  return { provider: "gmail", message_id: body.id ?? null, thread_id: body.threadId ?? null };
}

export const EMAIL_TOOLS = [emailDraft, emailSend];
