import type { AgentRow, AppApprovalRow, ApprovalRow, BriefRow, DivisionRow, DocumentRow, DraftRow, EventRow, SettingsRow, TaskRow } from "@agent-city/core";
import { create } from "zustand";

export const EVENT_LIMIT = 200;
export const DRAFT_LIMIT = 100;

export type Connection = "connecting" | "live" | "reconnecting" | "offline" | "demo";
export type PanelTab = "division" | "approvals" | "brief";

export interface Hydration {
  divisions: DivisionRow[];
  agents: AgentRow[];
  approvals: ApprovalRow[];
  /** Approvals waiting in connected company apps (FedOps, ...), mirrored read-only: the app decides them. */
  appApprovals: AppApprovalRow[];
  events: EventRow[];
  tasks: TaskRow[];
  /** Devlogs, posts, reports and plans written by agents and crews, newest first. */
  drafts: DraftRow[];
  /** Knowledge documents (not archived), most recently updated first. */
  documents: DocumentRow[];
  brief: BriefRow | null;
  settings: SettingsRow | null;
}

export interface CityState extends Hydration {
  connection: Connection;
  hydrated: boolean;
  selectedDivisionId: string | null;
  focusDivisionId: string | null;
  focusToken: number;
  panelTab: PanelTab;
  panelOpen: boolean;
  lowGraphics: boolean;
  cameraResetToken: number;
  /** divisionId -> ISO time errors were acknowledged (per browser). */
  acks: Record<string, string>;

  hydrate(data: Hydration): void;
  upsertDivision(row: DivisionRow): void;
  upsertAgent(row: AgentRow): void;
  upsertApproval(row: ApprovalRow): void;
  removeApproval(id: string): void;
  upsertAppApproval(row: AppApprovalRow): void;
  pushEvent(row: EventRow): void;
  upsertTask(row: TaskRow): void;
  upsertDraft(row: DraftRow): void;
  upsertDocument(row: DocumentRow): void;
  setBrief(row: BriefRow): void;
  setSettings(row: SettingsRow): void;
  setConnection(connection: Connection): void;

  selectDivision(id: string | null, options?: { focus?: boolean }): void;
  setPanelTab(tab: PanelTab): void;
  setPanelOpen(open: boolean): void;
  setLowGraphics(low: boolean): void;
  resetCamera(): void;
  acknowledge(divisionId: string): void;
}

const ACK_KEY = "agent-city.acks";
const LOW_KEY = "agent-city.low-graphics";

function readLocal<T>(key: string, fallback: T): T {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeLocal(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or blocked storage: the preference just won't persist.
  }
}

const newestFirst = (drafts: DraftRow[]) =>
  [...drafts].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0)).slice(0, DRAFT_LIMIT);

/** Live documents, most recently updated first; archived ones drop out. */
const liveDocuments = (docs: DocumentRow[]) =>
  docs.filter((d) => !d.archived).sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));

const sameAppApproval = (a: AppApprovalRow, b: AppApprovalRow) => a.app === b.app && a.external_id === b.external_id;

function upsertBy<T extends { id: string | number }>(rows: T[], row: T): T[] {
  const index = rows.findIndex((r) => r.id === row.id);
  if (index === -1) return [...rows, row];
  const next = rows.slice();
  next[index] = row;
  return next;
}

export const useCity = create<CityState>((set, get) => ({
  divisions: [],
  agents: [],
  approvals: [],
  appApprovals: [],
  events: [],
  tasks: [],
  drafts: [],
  documents: [],
  brief: null,
  settings: null,
  connection: "connecting",
  hydrated: false,
  selectedDivisionId: "hq",
  focusDivisionId: null,
  focusToken: 0,
  panelTab: "division",
  panelOpen: true,
  lowGraphics: false,
  cameraResetToken: 0,
  acks: {},

  hydrate: (data) =>
    set({
      ...data,
      events: [...data.events].sort((a, b) => b.id - a.id).slice(0, EVENT_LIMIT),
      drafts: newestFirst(data.drafts),
      documents: liveDocuments(data.documents),
      hydrated: true,
      acks: readLocal(ACK_KEY, {}),
      lowGraphics: readLocal(LOW_KEY, false),
    }),
  upsertDivision: (row) => set((s) => ({ divisions: upsertBy(s.divisions, row) })),
  upsertAgent: (row) => set((s) => ({ agents: upsertBy(s.agents, row) })),
  upsertApproval: (row) => set((s) => ({ approvals: upsertBy(s.approvals, row) })),
  removeApproval: (id) => set((s) => ({ approvals: s.approvals.filter((a) => a.id !== id) })),
  upsertAppApproval: (row) => set((s) => ({ appApprovals: [...s.appApprovals.filter((a) => !sameAppApproval(a, row)), row] })),
  pushEvent: (row) =>
    set((s) => {
      if (s.events.some((e) => e.id === row.id)) return s;
      return { events: [row, ...s.events].sort((a, b) => b.id - a.id).slice(0, EVENT_LIMIT) };
    }),
  upsertTask: (row) => set((s) => ({ tasks: upsertBy(s.tasks, row) })),
  upsertDraft: (row) => set((s) => ({ drafts: newestFirst(upsertBy(s.drafts, row)) })),
  upsertDocument: (row) => set((s) => ({ documents: liveDocuments(upsertBy(s.documents, row)) })),
  setBrief: (row) => set((s) => (s.brief && s.brief.created_at > row.created_at ? s : { brief: row })),
  setSettings: (row) => set({ settings: row }),
  setConnection: (connection) => set({ connection }),

  selectDivision: (id, options) =>
    set((s) => ({
      selectedDivisionId: id,
      panelTab: "division",
      panelOpen: id ? true : s.panelOpen,
      ...(options?.focus && id ? { focusDivisionId: id, focusToken: s.focusToken + 1 } : {}),
    })),
  setPanelTab: (panelTab) => set({ panelTab, panelOpen: true }),
  setPanelOpen: (panelOpen) => set({ panelOpen }),
  setLowGraphics: (lowGraphics) => {
    writeLocal(LOW_KEY, lowGraphics);
    set({ lowGraphics });
  },
  resetCamera: () => set((s) => ({ cameraResetToken: s.cameraResetToken + 1, focusDivisionId: null })),
  acknowledge: (divisionId) => {
    const acks = { ...get().acks, [divisionId]: new Date().toISOString() };
    writeLocal(ACK_KEY, acks);
    set({ acks });
  },
}));
