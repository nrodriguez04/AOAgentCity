"use client";

import type { DocumentRow } from "@agent-city/core";
import { useId, useState, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import { createDocument, editDocument } from "@/lib/actions";
import { relativeTime } from "@/lib/format";
import { useCity } from "@/lib/store";
import { announce } from "./Announcer";

/** "Q4 priorities!" -> "q4-priorities": the document's short id, which agents use to read it. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

const parseTags = (text: string) =>
  [...new Set(text.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 20);

/**
 * A division's knowledge: strategy, rules, decisions and lessons that its agents
 * search during runs (HQ reads every division). Nico writes and edits documents
 * here; agents can add notes of their own but never change his.
 */
export function KnowledgeList({ divisionId, documents, now }: { divisionId: string; documents: DocumentRow[]; now: number }) {
  const [adding, setAdding] = useState(false);
  return (
    <>
      {documents.length === 0 && !adding ? (
        <p className="muted small">No documents yet. Add the strategy, rules or decisions this division's agents should follow.</p>
      ) : null}
      {documents.length > 0 ? (
        <ul className="drafts">
          {documents.map((d) => (
            <li key={d.id}>
              <DocumentItem doc={d} now={now} />
            </li>
          ))}
        </ul>
      ) : null}
      {adding ? (
        <NewDocumentForm divisionId={divisionId} onDone={() => setAdding(false)} />
      ) : (
        <button type="button" className="btn btn-small knowledge-add" onClick={() => setAdding(true)}>
          New document
        </button>
      )}
    </>
  );
}

function DocumentItem({ doc, now }: { doc: DocumentRow; now: number }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const author = useCity((s) => (doc.updated_by === "owner" ? "you" : s.agents.find((a) => a.id === doc.updated_by)?.display_name ?? doc.updated_by));

  async function save(edit: Parameters<typeof editDocument>[1], done: string) {
    setBusy(true);
    setError(null);
    const result = await editDocument(doc.id, edit);
    setBusy(false);
    if (!result.ok) return setError(result.error);
    announce(`${done}: ${doc.title}`);
    setEditing(false);
  }

  return (
    <details className="draft knowledge-doc">
      <summary>
        <span className="draft-kind mono">Doc</span>
        <span className="draft-title">{doc.title}</span>
        <span className="muted small draft-meta">
          v{doc.version} · {author} · {relativeTime(doc.updated_at, now)}
          {doc.tags.length ? ` · ${doc.tags.join(", ")}` : ""}
        </span>
      </summary>
      {editing ? (
        <DocumentForm
          initial={{ title: doc.title, body_md: doc.body_md, tags: doc.tags.join(", ") }}
          busy={busy}
          submitLabel="Save"
          onCancel={() => setEditing(false)}
          onSubmit={(v) => save({ title: v.title, body_md: v.body_md, tags: parseTags(v.tags) }, "Saved")}
        />
      ) : (
        <>
          <div className="markdown draft-body">
            <ReactMarkdown>{doc.body_md}</ReactMarkdown>
          </div>
          <div className="draft-actions">
            <button type="button" className="btn btn-small" disabled={busy} onClick={() => setEditing(true)}>
              Edit
            </button>
            <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => save({ archived: true }, "Archived")}>
              Archive
            </button>
            <span className="muted small knowledge-id">
              id <code>{doc.slug}</code>
            </span>
          </div>
        </>
      )}
      {error ? (
        <p className="error-text draft-error" role="alert">
          {error}
        </p>
      ) : null}
    </details>
  );
}

function NewDocumentForm({ divisionId, onDone }: { divisionId: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(v: FormValues) {
    const slug = slugify(v.slug || v.title);
    if (!slug) return setError("Give the document a title with at least one letter or digit.");
    setBusy(true);
    setError(null);
    const result = await createDocument({ division_id: divisionId, slug, title: v.title, body_md: v.body_md, tags: parseTags(v.tags) });
    setBusy(false);
    if (!result.ok) return setError(result.error);
    announce(`Added: ${v.title}`);
    onDone();
  }

  return (
    <div className="draft knowledge-new">
      <DocumentForm initial={{ title: "", body_md: "", tags: "" }} busy={busy} submitLabel="Add document" withSlug onCancel={onDone} onSubmit={create} />
      {error ? (
        <p className="error-text draft-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

interface FormValues {
  title: string;
  slug: string;
  body_md: string;
  tags: string;
}

function DocumentForm({
  initial,
  busy,
  submitLabel,
  withSlug = false,
  onSubmit,
  onCancel,
}: {
  initial: Omit<FormValues, "slug">;
  busy: boolean;
  submitLabel: string;
  withSlug?: boolean;
  onSubmit: (values: FormValues) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [title, setTitle] = useState(initial.title);
  const [slug, setSlug] = useState("");
  const [tags, setTags] = useState(initial.tags);
  const [body, setBody] = useState(initial.body_md);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (title.trim() && body.trim()) onSubmit({ title: title.trim(), slug: slug.trim(), body_md: body, tags });
  }

  return (
    <form className="draft-edit" onSubmit={submit}>
      <label htmlFor={`${id}-title`} className="label">
        Title
      </label>
      <input id={`${id}-title`} value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
      {withSlug ? (
        <>
          <label htmlFor={`${id}-slug`} className="label">
            Short id <span className="muted">(how agents refer to it)</span>
          </label>
          <input
            id={`${id}-slug`}
            value={slug}
            placeholder={slugify(title) || "content-strategy"}
            onChange={(e) => setSlug(e.target.value)}
            pattern="[a-z0-9][a-z0-9-]{0,79}"
            maxLength={80}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            aria-describedby={`${id}-slug-help`}
          />
          <p id={`${id}-slug-help`} className="muted small">
            Lowercase letters, digits and hyphens. Leave it empty to use the title.
          </p>
        </>
      ) : null}
      <label htmlFor={`${id}-tags`} className="label">
        Tags <span className="muted">(comma separated, optional)</span>
      </label>
      <input id={`${id}-tags`} value={tags} onChange={(e) => setTags(e.target.value)} maxLength={400} autoCapitalize="off" />
      <label htmlFor={`${id}-body`} className="label">
        Text <span className="muted">(markdown)</span>
      </label>
      <textarea id={`${id}-body`} value={body} onChange={(e) => setBody(e.target.value)} required maxLength={100_000} rows={12} />
      <div className="draft-actions">
        <button type="submit" className="btn btn-small btn-approve" disabled={busy}>
          {busy ? "Saving…" : submitLabel}
        </button>
        <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
