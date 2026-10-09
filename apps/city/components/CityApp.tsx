"use client";

import type { Session } from "@supabase/supabase-js";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { startDemo } from "@/lib/demo";
import { connectRealtime } from "@/lib/realtime";
import { useCity } from "@/lib/store";
import { supabase, supabaseConfigured } from "@/lib/supabase";
import { deriveAmbience, deriveVisualState } from "@/lib/visual-state";
import { Announcer } from "./panel/Announcer";
import { DivisionBar } from "./panel/DivisionBar";
import { LoginCard, NotOwnerCard } from "./panel/LoginCard";
import { SidePanel } from "./panel/SidePanel";
import { TopBar } from "./panel/TopBar";

const CityScene = dynamic(() => import("./city/CityScene"), {
  ssr: false,
  loading: () => <div className="scene-loading" aria-hidden="true" />,
});

/** Live (Supabase) when configured; demo simulation otherwise, or with ?demo. */
export default function CityApp() {
  const [mode, setMode] = useState<"demo" | "live" | null>(null);
  useEffect(() => {
    const forceDemo = new URLSearchParams(window.location.search).has("demo");
    setMode(!supabaseConfigured || forceDemo ? "demo" : "live");
  }, []);
  if (mode === null) return <div className="scene-loading" aria-hidden="true" />;
  return mode === "demo" ? <DemoCity /> : <LiveCity />;
}

function DemoCity() {
  useEffect(() => startDemo(), []);
  return <CityShell />;
}

function LiveCity() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [owner, setOwner] = useState<boolean | null>(null);

  useEffect(() => {
    const db = supabase();
    void db.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = db.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => data.subscription.unsubscribe();
  }, []);

  const userId = session?.user.id;
  useEffect(() => {
    if (!userId) return;
    setOwner(null);
    void supabase()
      .rpc("is_owner")
      .then(({ data, error }) => setOwner(!error && data === true));
  }, [userId]);

  useEffect(() => {
    if (!owner) return;
    return connectRealtime();
  }, [owner]);

  const signOut = () => void supabase().auth.signOut();

  if (session === undefined) return <div className="scene-loading" aria-hidden="true" />;
  if (!session) return <LoginCard />;
  if (owner === null) return <div className="scene-loading" aria-hidden="true" />;
  if (!owner) return <NotOwnerCard userId={session.user.id} onSignOut={signOut} />;
  return <CityShell onSignOut={signOut} />;
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function CityShell({ onSignOut }: { onSignOut?: () => void }) {
  const now = useNow(1_000);
  const snapshot = useCity(
    useShallow((s) => ({
      divisions: s.divisions,
      agents: s.agents,
      approvals: s.approvals,
      events: s.events,
      brief: s.brief,
      settings: s.settings,
      acks: s.acks,
      selectedDivisionId: s.selectedDivisionId,
    })),
  );
  const lowGraphics = useCity((s) => s.lowGraphics);
  const focusDivisionId = useCity((s) => s.focusDivisionId);
  const cameraResetToken = useCity((s) => s.cameraResetToken);
  const selectDivision = useCity((s) => s.selectDivision);
  const setPanelOpen = useCity((s) => s.setPanelOpen);

  const buildings = useMemo(() => deriveVisualState(snapshot, now), [snapshot, now]);
  const ambience = useMemo(() => deriveAmbience(snapshot, lowGraphics, now), [snapshot, lowGraphics, now]);

  // Start with the panel closed on phones so the city is visible first.
  useEffect(() => {
    if (window.matchMedia("(max-width: 760px)").matches) setPanelOpen(false);
  }, [setPanelOpen]);

  return (
    <div className="city-shell">
      <div className="scene-layer">
        <CityScene
          buildings={buildings}
          ambience={ambience}
          focusDivisionId={focusDivisionId}
          cameraResetToken={cameraResetToken}
          onSelectDivision={(id) => selectDivision(id, { focus: true })}
        />
      </div>
      <TopBar now={now} onSignOut={onSignOut} />
      <SidePanel buildings={buildings} now={now} />
      <DivisionBar buildings={buildings} />
      <Announcer />
    </div>
  );
}
