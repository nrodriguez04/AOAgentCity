"use client";

import type { DraftReview, DraftRow } from "@agent-city/core";
import { useId, useState, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import { reviewDraft } from "@/lib/actions";
import { relativeTime } from "@/lib/format";
import { announce } from "./Announcer";

const KIND_LABEL: Record<DraftRow["kind"], string> = {
  devlog: "Devlog",
  social_post: "Post",
  article: "Article",
  newsletter: "Newsletter",
  report: "Report",
  plan: "Plan",
  other: "Draft",
};

const STATUS_LABEL: Record<DraftRow["status"], string> = {
  draft: "Draft",
  approved: "Approved",
  published: "Published",
  discarded: "Discarded",
};

/**
 * Documents agents and crews wrote for review. Each opens to its full text, which
 * Nico can approve, edit, discard, copy, or mark published once he has posted it.
 * Nothing here posts anywhere: publishing stays manual until a platform's API is
 * connected behind the approval queue.
 */
export function DraftList({ drafts, now, showDivision = false }: { drafts: DraftRow[]; now: number; showDivision?: boolean }) {
  if (drafts.length === 0) return <p className="muted small">No drafts yet.</p>;
  return (
    <ul className="drafts">
      {drafts.map((d) => (
        <li key={d.id}>
          <DraftItem draft={d} now={now} showDivision={showDivision} />
        </li>
      ))}
    </ul>
  );
}

type Mode = "read" | "edit" | "publish";

function DraftItem({ draft, now, showDivision }: { draft: DraftRow; now: number; showDivision: boolean }) {
  const id = useId();
  const [mode, setMode] = useState<Mode>("read");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function apply(review: DraftReview, done: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    const result = await reviewDraft(draft.id, review);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    announce(`${done}: ${draft.title}`);
    setMode("read");
    return true;
  }

  async function copy() {
    setError(null);
    try {
      await navigator.clipboard.writeText(draft.body_md);
      announce(`Copied: ${draft.title}`);
    } catch {
      setError("The browser blocked copying. Select the text and copy it instead.");
    }
  }

  return (
    <details className="draft" data-kind={draft.kind} data-status={draft.status}>
      <summary>
        <span className="draft-kind mono">{KIND_LABEL[draft.kind]}</span>
        <span className="draft-title">
          {draft.title}
          {draft.status !== "draft" ? (
            <span className="draft-status" data-status={draft.status}>
              {STATUS_LABEL[draft.status]}
            </span>
          ) : null}
        </span>
        <span className="muted small draft-meta">
          {[showDivision ? draft.division_id : null, draft.channel, relativeTime(draft.created_at, now)].filter(Boolean).join(" · ")}
        </span>
      </summary>

      {mode === "edit" ? (
        <EditForm draft={draft} busy={busy} onCancel={() => setMode("read")} onSave={(title, body) => apply({ title, body_md: body }, "Saved")} />
      ) : (
        <div className="markdown draft-body">
          <ReactMarkdown>{draft.body_md}</ReactMarkdown>
        </div>
      )}

      {draft.original_body_md !== null && mode === "read" ? (
        <details className="draft-original">
          <summary className="muted small">You edited this. Show what the agent wrote</summary>
          <div className="markdown draft-body">
            <ReactMarkdown>{draft.original_body_md}</ReactMarkdown>
          </div>
        </details>
      ) : null}

      {mode === "publish" ? (
        <PublishForm busy={busy} onCancel={() => setMode("read")} onSave={(url) => apply({ status: "published", published_url: url }, "Marked published")} />
      ) : null}

      {mode === "read" ? (
        <div className="draft-actions" role="group" aria-labelledby={`${id}-actions`}>
          <span id={`${id}-actions`} className="visually-hidden">
            Review {draft.title}
          </span>
          {draft.status === "draft" ? (
            <>
              <button type="button" className="btn btn-small btn-approve" disabled={busy} onClick={() => apply({ status: "approved" }, "Approved")}>
                Approve
              </button>
              <button type="button" className="btn btn-small" disabled={busy} onClick={() => setMode("edit")}>
                Edit
              </button>
              <button type="button" className="btn btn-small btn-reject" disabled={busy} onClick={() => apply({ status: "discarded" }, "Discarded")}>
                Discard
              </button>
            </>
          ) : null}
          {draft.status === "approved" ? (
            <>
              <button type="button" className="btn btn-small btn-approve" disabled={busy} onClick={() => setMode("publish")}>
                Mark published
              </button>
              <button type="button" className="btn btn-small" disabled={busy} onClick={() => setMode("edit")}>
                Edit
              </button>
              <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => apply({ status: "draft" }, "Moved back to drafts")}>
                Back to draft
              </button>
            </>
          ) : null}
          {draft.status === "discarded" ? (
            <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => apply({ status: "draft" }, "Restored")}>
              Restore
            </button>
          ) : null}
          {draft.status === "published" && draft.published_url ? (
            <a className="btn btn-small btn-ghost" href={draft.published_url} target="_blank" rel="noopener noreferrer">
              Open the post
            </a>
          ) : null}
          {draft.status !== "discarded" ? (
            <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={copy}>
              Copy text
            </button>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p className="error-text draft-error" role="alert">
          {error}
        </p>
      ) : null}
    </details>
  );
}

function EditForm({ draft, busy, onSave, onCancel }: { draft: DraftRow; busy: boolean; onSave: (title: string, body: string) => void; onCancel: () => void }) {
  const id = useId();
  const [title, setTitle] = useState(draft.title);
  const [body, setBody] = useState(draft.body_md);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (title.trim() && body.trim()) onSave(title.trim(), body);
  }

  return (
    <form className="draft-edit" onSubmit={submit}>
      <label htmlFor={`${id}-title`} className="label">
        Title
      </label>
      <input id={`${id}-title`} value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
      <label htmlFor={`${id}-body`} className="label">
        Text <span className="muted">(markdown)</span>
      </label>
      <textarea id={`${id}-body`} value={body} onChange={(e) => setBody(e.target.value)} required maxLength={40_000} rows={12} />
      <div className="draft-actions">
        <button type="submit" className="btn btn-small btn-approve" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function PublishForm({ busy, onSave, onCancel }: { busy: boolean; onSave: (url: string | null) => void; onCancel: () => void }) {
  const id = useId();
  const [url, setUrl] = useState("");

  function submit(e: FormEvent) {
    e.preventDefault();
    onSave(url.trim() || null);
  }

  return (
    <form className="draft-edit" onSubmit={submit}>
      <label htmlFor={`${id}-url`} className="label">
        Where you posted it <span className="muted">(optional)</span>
      </label>
      <input
        id={`${id}-url`}
        type="url"
        inputMode="url"
        autoComplete="url"
        placeholder="https://"
        pattern="https?://.+"
        maxLength={2000}
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        aria-describedby={`${id}-help`}
      />
      <p id={`${id}-help`} className="muted small">
        Agent City does not post for you yet. Paste the link to the post so the agents can see what went out.
      </p>
      <div className="draft-actions">
        <button type="submit" className="btn btn-small btn-approve" disabled={busy}>
          {busy ? "Saving…" : "Mark published"}
        </button>
        <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
