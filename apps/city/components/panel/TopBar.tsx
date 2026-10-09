"use client";

import { useState } from "react";
import { setCityPaused } from "@/lib/actions";
import { clockTime } from "@/lib/format";
import { useCity, type Connection } from "@/lib/store";
import { announce } from "./Announcer";

const CONNECTION_LABEL: Record<Connection, string> = {
  connecting: "Connecting",
  live: "Live",
  reconnecting: "Reconnecting",
  offline: "Offline",
  demo: "Demo",
};

export function TopBar({ now, onSignOut }: { now: number; onSignOut?: () => void }) {
  const connection = useCity((s) => s.connection);
  const paused = useCity((s) => Boolean(s.settings?.agents_paused));
  const lowGraphics = useCity((s) => s.lowGraphics);
  const setLowGraphics = useCity((s) => s.setLowGraphics);
  const resetCamera = useCity((s) => s.resetCamera);
  const panelOpen = useCity((s) => s.panelOpen);
  const setPanelOpen = useCity((s) => s.setPanelOpen);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function togglePause() {
    setBusy(true);
    setError(null);
    const result = await setCityPaused(!paused);
    setBusy(false);
    if (result.ok) announce(paused ? "City resumed. Agents will run on schedule." : "City paused. No agent runs or approved actions will start.");
    else setError(result.error);
  }

  return (
    <header className="top-bar">
      <div className="brand glass">
        <span className="wordmark mono">AGENT CITY</span>
        <span className="connection" data-state={connection}>
          <span className="connection-dot" aria-hidden="true" />
          {CONNECTION_LABEL[connection]}
        </span>
        <span className="clock mono" aria-label="Local time in Chicago">
          {clockTime(new Date(now))}
        </span>
      </div>

      <div className="controls glass" role="group" aria-label="City controls">
        <button type="button" className="btn btn-pause" aria-pressed={paused} disabled={busy} onClick={togglePause}>
          {paused ? "Resume" : "Pause"}
          <span className="wide-only"> city</span>
        </button>
        <button type="button" className="btn btn-ghost" aria-pressed={lowGraphics} onClick={() => setLowGraphics(!lowGraphics)}>
          Low graphics
        </button>
        <button type="button" className="btn btn-ghost" onClick={resetCamera}>
          Reset<span className="wide-only"> camera</span>
        </button>
        {!panelOpen ? (
          <button type="button" className="btn btn-ghost" onClick={() => setPanelOpen(true)}>
            <span className="wide-only">Show </span>Panel
          </button>
        ) : null}
        {onSignOut ? (
          <button type="button" className="btn btn-ghost" onClick={onSignOut}>
            Sign out
          </button>
        ) : null}
      </div>
      {paused ? (
        <p className="paused-banner glass" role="status">
          Paused: no agent runs or approved actions will start until you resume.
        </p>
      ) : null}
      {connection === "demo" ? (
        <p className="demo-note glass small">Simulated data. Set the Supabase environment variables to connect the live city.</p>
      ) : null}
      {error ? (
        <p className="error-text glass" role="alert">
          {error}
        </p>
      ) : null}
    </header>
  );
}
