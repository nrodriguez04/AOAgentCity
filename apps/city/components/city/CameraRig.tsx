"use client";

import { OrbitControls } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef, type ComponentRef } from "react";
import * as THREE from "three";
import { OVERVIEW } from "@/lib/scene/layout";
import type { ViewInsets } from "@/lib/visual-types";

// Orbit camera with limits, a diorama overview, smooth fly-to for hero towers
// and a gentle idle auto-rotate. The glass UI covers parts of the canvas, so
// the projection is shifted (setViewOffset) to centre the subject in the
// unobstructed rectangle, and framing distances grow to fit it.

export interface FlyTarget {
  /** Division id (lets the framing planner ignore the tower itself as an occluder). */
  id: string;
  x: number;
  z: number;
  /** Visible height of the building being framed. */
  height: number;
  /** Half the footprint diagonal. */
  radius: number;
  /** 0..1: where on the tower to aim. */
  aim?: number;
}

export type FramingPlan = (t: FlyTarget, fit: number) => { position: THREE.Vector3; target: THREE.Vector3 };

export interface CameraApi {
  flyTo(target: FlyTarget): void;
  overview(): void;
}

type Controls = ComponentRef<typeof OrbitControls>;

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const BOUNDS = { x0: -90, x1: 90, z0: -140, z1: 125, y1: 45 };
const ZERO_INSETS: ViewInsets = { top: 0, right: 0, bottom: 0, left: 0 };

export function framingFor(t: FlyTarget, fit = 1): { position: THREE.Vector3; target: THREE.Vector3 } {
  const h = Math.max(4, t.height);
  const target = new THREE.Vector3(t.x, Math.min(h * 0.42, 24), t.z);
  const dist = THREE.MathUtils.clamp(h * 1.25 + 16, 24, 92) * fit;
  // From the south-east, a little above: hero fronts face +z.
  const dir = new THREE.Vector3(0.5, h > 20 ? 0.36 : 0.46, 0.79).normalize();
  return { position: target.clone().addScaledVector(dir, dist), target };
}

export interface ViewPose {
  position: [number, number, number];
  target: [number, number, number];
}

/**
 * The overview pose for a given unobstructed aspect ratio. Landscape screens get
 * the designed south-east diorama view; narrow (portrait) screens swing toward
 * due south so the long north-south island runs up the screen, a little higher
 * and further back.
 */
function overviewFraming(fit: number, pose: ViewPose | undefined, aspect: number) {
  const base = pose ?? OVERVIEW;
  const target = new THREE.Vector3(...base.target);
  const offset = new THREE.Vector3(...base.position).sub(target);
  if (!pose) {
    const t = THREE.MathUtils.smoothstep(aspect, 0.55, 1.45);
    const dist = offset.length() * (aspect < 1.4 ? Math.pow(1.4 / Math.max(0.3, aspect), 0.62) : 1);
    const az = THREE.MathUtils.degToRad(THREE.MathUtils.lerp(6, 32.1, t));
    const el = THREE.MathUtils.degToRad(THREE.MathUtils.lerp(31, 21.95, t));
    offset.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(dist);
    // Portrait: aim a little further north so both skyline clusters fit.
    target.z -= (1 - t) * 14;
  }
  return { position: target.clone().add(offset.multiplyScalar(fit)), target };
}

/** How much farther to stand back so a shot framed for the full canvas fits the clear area. */
function fitFactor(w: number, h: number, insets: ViewInsets): number {
  const vw = Math.max(80, w - insets.left - insets.right);
  const vh = Math.max(80, h - insets.top - insets.bottom);
  const k = Math.max(w / vw, h / vh);
  return 1 + (Math.min(k, 2.4) - 1) * 0.72;
}

export function CameraRig({
  apiRef,
  focus,
  focusKey,
  resetToken,
  insets = ZERO_INSETS,
  reducedMotion,
  plan,
  home,
}: {
  /** Override of the overview pose (debug/preview). */
  home?: ViewPose;
  /** Occlusion-aware framing for fly-to (falls back to a fixed south-east view). */
  plan?: FramingPlan;
  apiRef: { current: CameraApi | null };
  focus: FlyTarget | null;
  /** Changes whenever a (re)focus is requested. */
  focusKey: string;
  resetToken: number;
  insets?: ViewInsets;
  reducedMotion: boolean;
}) {
  const controls = useRef<Controls>(null);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);
  const flight = useRef<{
    fromPos: THREE.Vector3;
    fromTarget: THREE.Vector3;
    toPos: THREE.Vector3;
    toTarget: THREE.Vector3;
    t: number;
    duration: number;
    lift: number;
  } | null>(null);
  /** What the camera is framing: the overview, a tower, or wherever the user left it. */
  const mode = useRef<{ kind: "overview" } | { kind: "focus"; target: FlyTarget } | { kind: "free" }>({ kind: "overview" });
  const lastInteraction = useRef(0);
  const clock = useRef(0);
  const fit = useRef(1);
  /** Aspect ratio of the unobstructed part of the canvas. */
  const aspect = useRef(1.6);
  const initialized = useRef(false);
  const reduced = useRef(reducedMotion);
  reduced.current = reducedMotion;
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const planRef = useRef(plan);
  planRef.current = plan;
  const homeRef = useRef(home);
  homeRef.current = home;

  const api = useMemo<CameraApi>(() => {
    const start = (toPos: THREE.Vector3, toTarget: THREE.Vector3) => {
      const c = controls.current;
      if (!c) return;
      c.autoRotate = false;
      const fromPos = camera.position.clone();
      const fromTarget = c.target.clone();
      const travel = fromPos.distanceTo(toPos) + fromTarget.distanceTo(toTarget);
      const duration = reduced.current ? 0.25 : THREE.MathUtils.clamp(0.9 + travel / 160, 1.1, 2.4);
      flight.current = {
        fromPos,
        fromTarget,
        toPos: toPos.clone(),
        toTarget: toTarget.clone(),
        t: 0,
        duration,
        lift: reduced.current ? 0 : Math.min(18, fromPos.distanceTo(toPos) * 0.12),
      };
      lastInteraction.current = clock.current;
    };
    return {
      flyTo(t) {
        mode.current = { kind: "focus", target: t };
        const f = planRef.current ? planRef.current(t, fit.current) : framingFor(t, fit.current);
        start(f.position, f.target);
      },
      overview() {
        mode.current = { kind: "overview" };
        const f = overviewFraming(fit.current, homeRef.current, aspect.current);
        start(f.position, f.target);
      },
    };
  }, [camera]);

  useLayoutEffect(() => {
    apiRef.current = api;
    return () => {
      apiRef.current = null;
    };
  }, [api, apiRef]);

  // Centre the projection in the unobstructed rectangle and re-fit the framing.
  const { top, right, bottom, left } = insets;
  useLayoutEffect(() => {
    const w = size.width;
    const h = size.height;
    if (w < 2 || h < 2) return;
    const ins = { top, right, bottom, left };
    const vw = Math.max(80, w - left - right);
    const vh = Math.max(80, h - top - bottom);
    const cx = left + vw / 2;
    const cy = top + vh / 2;
    const ox = w / 2 - cx;
    const oy = h / 2 - cy;
    if (Math.abs(ox) < 0.5 && Math.abs(oy) < 0.5) camera.clearViewOffset();
    else camera.setViewOffset(w, h, ox, oy, w, h);
    camera.updateProjectionMatrix();
    const nextFit = fitFactor(w, h, ins);
    const nextAspect = vw / vh;
    const changed = Math.abs(nextFit - fit.current) > 0.01 || Math.abs(nextAspect - aspect.current) > 0.05;
    fit.current = nextFit;
    aspect.current = nextAspect;
    if (changed && initialized.current && controls.current) {
      const m = mode.current;
      if (m.kind === "overview") api.overview();
      else if (m.kind === "focus") api.flyTo(m.target);
    }
  }, [size.width, size.height, top, right, bottom, left, camera, api]);

  // Initial framing (no flight), and cancel flights when the user grabs the camera.
  useLayoutEffect(() => {
    const c = controls.current;
    if (!c) return;
    const f = overviewFraming(fit.current, homeRef.current, aspect.current);
    c.target.copy(f.target);
    camera.position.copy(f.position);
    camera.lookAt(f.target);
    c.update();
    initialized.current = true;
    const onStart = () => {
      flight.current = null;
      mode.current = { kind: "free" };
      lastInteraction.current = clock.current;
      c.autoRotate = false;
    };
    c.addEventListener("start", onStart);
    return () => c.removeEventListener("start", onStart);
  }, [camera]);

  // Focus requests (focusDivisionId / focusToken).
  useEffect(() => {
    const f = focusRef.current;
    if (f) api.flyTo(f);
  }, [focusKey, api]);

  // When the city (and so the framing planner) arrives after a focus request, re-frame.
  useEffect(() => {
    const m = mode.current;
    const f = focusRef.current;
    if (m.kind === "focus" && f && f.id === m.target.id) api.flyTo(f);
  }, [plan, api]);

  // Reset to the overview (skip the initial value).
  const firstReset = useRef(true);
  useEffect(() => {
    if (firstReset.current) {
      firstReset.current = false;
      return;
    }
    api.overview();
  }, [resetToken, api]);

  useFrame((state, dt) => {
    clock.current = state.clock.elapsedTime;
    const c = controls.current;
    if (!c) return;
    const f = flight.current;
    if (f) {
      f.t = Math.min(1, f.t + dt / f.duration);
      const k = easeInOutCubic(f.t);
      camera.position.lerpVectors(f.fromPos, f.toPos, k);
      camera.position.y += Math.sin(Math.PI * k) * f.lift;
      c.target.lerpVectors(f.fromTarget, f.toTarget, k);
      if (f.t >= 1) {
        flight.current = null;
        lastInteraction.current = state.clock.elapsedTime;
      }
    }
    c.target.x = THREE.MathUtils.clamp(c.target.x, BOUNDS.x0, BOUNDS.x1);
    c.target.z = THREE.MathUtils.clamp(c.target.z, BOUNDS.z0, BOUNDS.z1);
    c.target.y = THREE.MathUtils.clamp(c.target.y, 0, BOUNDS.y1);
    if (camera.position.y < 2) camera.position.y = 2;
    // Gentle idle auto-rotate (never with reduced motion).
    const idle = state.clock.elapsedTime - lastInteraction.current > 30;
    c.autoRotate = !reduced.current && !f && idle;
    c.autoRotateSpeed = 0.16;
  });

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping
      dampingFactor={0.075}
      minDistance={10}
      maxDistance={330}
      minPolarAngle={0.12}
      maxPolarAngle={1.36}
      zoomSpeed={0.8}
      rotateSpeed={0.55}
      panSpeed={0.8}
      screenSpacePanning={false}
    />
  );
}
