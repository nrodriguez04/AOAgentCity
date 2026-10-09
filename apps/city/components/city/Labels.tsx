"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import type { BuildingVisuals, ViewInsets } from "@/lib/visual-types";

// Division name labels as plain DOM, positioned every frame from the 3D
// scene (one projector inside the canvas, one absolutely positioned layer
// outside it). Cheaper than a React root per label and StrictMode-safe.

export type LabelRegistry = Map<string, HTMLDivElement>;

export interface LabelAnchor {
  divisionId: string;
  /** Label point in world space. */
  position: THREE.Vector3;
}

const LABEL_CSS = `
@keyframes ac-beacon { 0%, 100% { box-shadow: 0 0 0 0 rgba(255,181,71,0); } 50% { box-shadow: 0 0 10px 2px rgba(255,181,71,0.55); } }
.ac-labels { position: absolute; inset: 0; pointer-events: none; overflow: hidden; z-index: 1; }
.ac-label { position: absolute; left: 0; top: 0; will-change: transform; opacity: 0;
  font-family: var(--font-mono, ui-monospace, monospace); font-size: 10px; letter-spacing: 0.09em; text-transform: uppercase;
  color: rgba(231,236,246,0.86); background: rgba(7,11,20,0.58); border: 1px solid rgba(148,170,214,0.22);
  padding: 2px 7px 2px 6px; border-radius: 999px; white-space: nowrap; display: inline-flex; align-items: center; gap: 6px;
  cursor: pointer; user-select: none; pointer-events: auto; text-shadow: 0 1px 2px rgba(0,0,0,0.6);
  transition: background 160ms ease, border-color 160ms ease, color 160ms ease, box-shadow 160ms ease, opacity 200ms ease; }
.ac-label:hover, .ac-label[data-hover="1"] { color: #fff; border-color: rgba(190,210,255,0.5); background: rgba(10,16,30,0.8); }
.ac-label[data-selected="1"] { color: #fff; border-color: rgba(120,200,255,0.85); background: rgba(10,22,40,0.88); box-shadow: 0 0 14px rgba(90,176,255,0.35); }
.ac-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
.ac-badge { font-weight: 700; color: #1a1205; background: #ffb547; border-radius: 999px; padding: 0 5px; line-height: 14px;
  font-size: 9.5px; letter-spacing: 0.02em; animation: ac-beacon 1.2s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .ac-badge { animation: none; } .ac-label { transition: none; } }
`;

function useLabelCss() {
  useEffect(() => {
    if (document.querySelector("style[data-agent-city-labels]")) return;
    const el = document.createElement("style");
    el.setAttribute("data-agent-city-labels", "");
    el.textContent = LABEL_CSS;
    document.head.appendChild(el);
  }, []);
}

export function dotColor(v: BuildingVisuals): string {
  if (v.crown === "error") return "#ff5a5f";
  if (v.underConstruction) return "#ffb547";
  if (v.dimmed || v.status === "paused") return "#8d9ab3";
  if (v.status === "live") return "#45d483";
  if (v.status === "planning") return "#5ab0ff";
  return "#ffb547";
}

/** DOM layer, rendered next to the <Canvas>. */
export function LabelLayer({
  buildings,
  registry,
  onSelect,
}: {
  buildings: BuildingVisuals[];
  registry: LabelRegistry;
  onSelect(divisionId: string): void;
}) {
  useLabelCss();
  return (
    <div className="ac-labels" aria-hidden={false}>
      {buildings.map((b) => {
        const badge = b.beacon.active ? b.beacon.count : 0;
        const color = dotColor(b);
        return (
          <div
            key={b.divisionId}
            ref={(el) => {
              if (el) registry.set(b.divisionId, el);
              else registry.delete(b.divisionId);
            }}
            className="ac-label"
            role="button"
            tabIndex={0}
            aria-label={`${b.name}${badge ? `, ${badge} pending approvals` : ""}`}
            data-selected={b.selected ? 1 : 0}
            data-rank={b.selected ? 2 : badge > 0 ? 1 : 0}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(b.divisionId);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") onSelect(b.divisionId);
            }}
          >
            <span className="ac-dot" style={{ background: color, boxShadow: `0 0 6px ${color}` }} />
            {b.name}
            {badge > 0 && <span className="ac-badge">{badge}</span>}
          </div>
        );
      })}
    </div>
  );
}

/** Pixels kept clear between a label and the edge of the visible area. */
const EDGE = 6;
/** Pixels between labels stacked to avoid overlapping. */
const GAP = 3;

interface Box {
  l: number;
  r: number;
  t: number;
  b: number;
}

/**
 * Inside the canvas: projects each anchor and moves its label. Labels stay in
 * the part of the canvas the glass UI leaves visible (hidden when their tower
 * is under the UI, slid inward at the edges) and lift above each other
 * instead of overlapping.
 */
export function LabelProjector({
  anchors,
  registry,
  insets,
}: {
  anchors: LabelAnchor[];
  registry: LabelRegistry;
  insets?: ViewInsets;
}) {
  const size = useThree((s) => s.size);
  const v = useMemo(() => new THREE.Vector3(), []);
  const camPos = useMemo(() => new THREE.Vector3(), []);
  const lifts = useMemo(() => new Map<string, number>(), []);
  useFrame(({ camera, controls }, dt) => {
    camera.getWorldPosition(camPos);
    const target = (controls as unknown as { target?: THREE.Vector3 } | null)?.target;
    const focusDist = target ? Math.max(20, camPos.distanceTo(target)) : 200;
    const left = (insets?.left ?? 0) + EDGE;
    const right = size.width - (insets?.right ?? 0) - EDGE;
    const top = (insets?.top ?? 0) + EDGE;
    const bottom = size.height - (insets?.bottom ?? 0) - EDGE;

    // Read every label's size before writing any style, so the browser never re-lays out mid-frame.
    const items = [];
    for (const a of anchors) {
      const el = registry.get(a.divisionId);
      if (!el) continue;
      v.copy(a.position).project(camera);
      const x = ((v.x + 1) / 2) * size.width;
      const y = ((1 - v.y) / 2) * size.height;
      items.push({
        id: a.divisionId,
        el,
        x,
        y,
        w: el.offsetWidth,
        h: el.offsetHeight,
        inView: v.z < 1 && v.z > -1 && x >= left && x <= right && y >= top && y <= bottom,
        dist: camPos.distanceTo(a.position),
        rank: Number(el.dataset.rank ?? 0),
      });
    }
    // The selected label and those with pending approvals keep their spot; nearer towers before farther ones.
    items.sort((p, q) => q.rank - p.rank || p.dist - q.dist);

    const placed: Box[] = [];
    const ease = 1 - Math.exp(-dt * 12);
    for (const it of items) {
      const half = it.w / 2;
      const x = right - left > it.w ? THREE.MathUtils.clamp(it.x, left + half, right - half) : (left + right) / 2;
      let y = it.y;
      for (let pass = 0; pass < 4; pass++) {
        const hit = placed.find(
          (p) => x - half < p.r + GAP && x + half > p.l - GAP && y - it.h / 2 < p.b + GAP && y + it.h / 2 > p.t - GAP,
        );
        if (!hit) break;
        y = hit.t - GAP - it.h / 2;
      }
      const visible = it.inView && y - it.h / 2 >= top - EDGE;
      if (visible) placed.push({ l: x - half, r: x + half, t: y - it.h / 2, b: y + it.h / 2 });
      // Ease the lift so labels slide apart rather than jump.
      const wanted = it.y - y;
      const lift = THREE.MathUtils.lerp(lifts.get(it.id) ?? wanted, wanted, ease);
      lifts.set(it.id, lift);

      const el = it.el;
      el.style.transform = `translate3d(${x.toFixed(1)}px, ${(it.y - lift).toFixed(1)}px, 0) translate(-50%, -50%)`;
      // Labels far beyond what the camera is looking at fade back, so close-ups stay calm.
      const op = visible ? (it.rank === 2 ? 1 : THREE.MathUtils.clamp(1.6 - (it.dist / focusDist) * 0.55, 0.16, 1)) : 0;
      el.style.opacity = op.toFixed(2);
      el.style.pointerEvents = visible ? "auto" : "none";
      const tabIndex = visible ? 0 : -1;
      if (el.tabIndex !== tabIndex) {
        el.tabIndex = tabIndex;
        el.setAttribute("aria-hidden", visible ? "false" : "true");
      }
    }
  });
  return null;
}
