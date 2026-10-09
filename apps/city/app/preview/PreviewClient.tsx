"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { DIVISIONS } from "@agent-city/core";
import type { BuildingVisuals, CityAmbience, ViewInsets } from "@/lib/visual-types";

const CityScene = dynamic(() => import("@/components/city/CityScene"), { ssr: false });

interface Props {
  low: boolean;
  paused: boolean;
  traffic: number;
  focus: string | null;
  select: string | null;
  insets: boolean;
  stats: boolean;
  /** Frame-rate cap for software-rendered screenshots (0 = uncapped). */
  fps: number;
  /** Optional camera pose: px,py,pz,tx,ty,tz. */
  cam: number[] | null;
  /** Hold the success flash mid-way (for screenshots). */
  flashHold: boolean;
}

const DESKTOP_INSETS: ViewInsets = { top: 64, right: 432, bottom: 88, left: 0 };

/** Mock visuals that exercise every state effect. */
function mockVisuals(now: number, flashAt: number, selected: string | null): BuildingVisuals[] {
  return DIVISIONS.map((d) => {
    const base: BuildingVisuals = {
      divisionId: d.id,
      name: d.name,
      model: d.slot.buildingModel,
      x: d.slot.x,
      z: d.slot.z,
      rotation: d.slot.rotation ?? 0,
      status: d.status,
      underConstruction: false,
      dimmed: false,
      floors: { bands: 1, activeBands: 0 },
      ambientLit: 0.2,
      crown: "steady",
      beacon: { active: false, count: 0 },
      flashAt: null,
      searchlightUntil: null,
      display: [],
      selected: selected === d.id,
    };
    switch (d.id) {
      case "hq":
        return { ...base, crown: "pulse", floors: { bands: 1, activeBands: 1 }, searchlightUntil: now + 60 * 60 * 1000 };
      case "parlaylab":
        return {
          ...base,
          status: "live",
          crown: "pulse",
          floors: { bands: 3, activeBands: 2 },
          beacon: { active: true, count: 2 },
          display: [
            { label: "MRR", value: "$12,480", tone: "up" },
            { label: "Active subs", value: "412", tone: "up" },
            { label: "Failed payments", value: "3", tone: "down" },
            { label: "Churn 30d", value: "2.1%", tone: "neutral" },
          ],
        };
      case "halo":
      case "fedops":
        return { ...base, status: "planned", underConstruction: true, crown: "off", ambientLit: 0 };
      case "galleyswap":
        return { ...base, status: "live", crown: "error", floors: { bands: 2, activeBands: 0 } };
      case "averageoutput":
        return { ...base, status: "live", crown: "steady", floors: { bands: 2, activeBands: 1 }, flashAt };
      case "finances":
        return { ...base, status: "live", dimmed: true, crown: "steady", floors: { bands: 1, activeBands: 0 } };
      case "health":
        return { ...base, status: "live", crown: "steady" };
      case "creatoros":
        return {
          ...base,
          status: "live",
          crown: "pulse",
          floors: { bands: 2, activeBands: 1 },
          beacon: { active: true, count: 1 },
          display: [
            { label: "Followers", value: "48.2K", tone: "up" },
            { label: "Views 24h", value: "1.3M", tone: "up" },
            { label: "Engagement", value: "6.4%", tone: "down" },
            { label: "Queued posts", value: "7", tone: "neutral" },
          ],
        };
      default:
        return base;
    }
  });
}

export default function PreviewClient({ low, paused, traffic, focus, select, insets, stats, fps, cam, flashHold }: Props) {
  const [now] = useState(() => Date.now());
  const [flashAt, setFlashAt] = useState(() => Date.now());
  const [resetToken, setResetToken] = useState(0);
  const [focusToken, setFocusToken] = useState(0);
  const [selected, setSelected] = useState<string | null>(select ?? focus);
  const [focusId, setFocusId] = useState<string | null>(focus);

  // Simulate run.succeeded every few seconds so the flash is easy to see
  // (or hold it 40% of the way up the building with ?flash=hold).
  useEffect(() => {
    const id = flashHold ? setInterval(() => setFlashAt(Date.now() - 600), 100) : setInterval(() => setFlashAt(Date.now()), 4000);
    return () => clearInterval(id);
  }, [flashHold]);

  const buildings = useMemo(() => mockVisuals(now, flashAt, selected), [now, flashAt, selected]);
  const ambience = useMemo<CityAmbience>(() => ({ trafficDensity: traffic, paused, lowGraphics: low }), [traffic, paused, low]);

  return (
    <main style={{ position: "fixed", inset: 0, background: "#070b14" }}>
      <CityScene
        buildings={buildings}
        ambience={ambience}
        focusDivisionId={focusId}
        focusToken={focusToken}
        cameraResetToken={resetToken}
        viewInsets={insets ? DESKTOP_INSETS : undefined}
        debug={{
          stats,
          maxFps: fps > 0 ? fps : undefined,
          view: cam ? { position: [cam[0]!, cam[1]!, cam[2]!], target: [cam[3]!, cam[4]!, cam[5]!] } : undefined,
        }}
        onSelectDivision={(id) => {
          setSelected(id);
          setFocusId(id);
          setFocusToken((n) => n + 1);
        }}
      />
      {insets && <InsetGuides />}
      <div style={{ position: "fixed", left: 12, bottom: insets ? 96 : 12, display: "flex", gap: 8, zIndex: 50 }}>
        <button
          onClick={() => {
            setSelected(null);
            setFocusId(null);
            setResetToken((n) => n + 1);
          }}
          style={buttonStyle}
        >
          reset camera
        </button>
      </div>
      {stats && <StatsOverlay />}
    </main>
  );
}

const buttonStyle: React.CSSProperties = {
  font: "11px var(--font-mono), monospace",
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "#e7ecf6",
  background: "rgba(10,15,28,0.78)",
  border: "1px solid rgba(148,170,214,0.25)",
  borderRadius: 6,
  padding: "6px 10px",
  cursor: "pointer",
};

/** Translucent stand-ins for the app's glass UI, to check framing with ?insets=1. */
function InsetGuides() {
  const glass: React.CSSProperties = {
    position: "fixed",
    background: "rgba(10,15,28,0.55)",
    border: "1px solid rgba(148,170,214,0.18)",
    backdropFilter: "blur(10px)",
    borderRadius: 14,
    zIndex: 40,
    pointerEvents: "none",
  };
  return (
    <>
      <div style={{ ...glass, top: 12, left: 16, right: 448, height: 40 }} />
      <div style={{ ...glass, top: 16, right: 16, bottom: 16, width: 400 }} />
      <div style={{ ...glass, left: 16, right: 448, bottom: 16, height: 56 }} />
    </>
  );
}

function StatsOverlay() {
  const [text, setText] = useState("");
  useEffect(() => {
    const id = setInterval(() => {
      const s = window.__cityStats;
      if (!s) return;
      setText(
        `draw calls ${s.calls} = scene ${s.sceneCalls} + reflection ${s.reflectionCalls} + post ${s.postCalls} · tris ${(s.triangles / 1000).toFixed(0)}k (scene ${(s.sceneTriangles / 1000).toFixed(0)}k, reflection ${(s.reflectionTriangles / 1000).toFixed(0)}k) · cpu ${s.cpuMs.toFixed(1)} ms · frame ${s.frames}`,
      );
    }, 500);
    return () => clearInterval(id);
  }, []);
  return (
    <div
      id="city-stats"
      style={{
        position: "fixed",
        top: 10,
        left: 12,
        zIndex: 60,
        font: "11px var(--font-mono), monospace",
        color: "#9fe8b8",
        background: "rgba(0,0,0,0.55)",
        padding: "4px 8px",
        borderRadius: 4,
      }}
    >
      {text || "measuring…"}
    </div>
  );
}
