"use client";

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import type * as THREE from "three";

export interface CityRenderStats {
  /** Draw calls for the whole frame (reflection + scene + post-processing). */
  calls: number;
  /** Draw calls of the main scene pass (main camera). */
  sceneCalls: number;
  /** Draw calls of the water reflection pass (and anything else rendered with another camera). */
  reflectionCalls: number;
  /** Full-screen post-processing passes. */
  postCalls: number;
  triangles: number;
  sceneTriangles: number;
  reflectionTriangles: number;
  /** CPU time spent issuing the frame (ms). */
  cpuMs: number;
  frames: number;
}

declare global {
  interface Window {
    __cityStats?: CityRenderStats;
  }
}

/**
 * Accumulates renderer.info over a whole frame (the composer renders several
 * passes) and publishes a per-pass breakdown on window.__cityStats.
 */
export function RenderStats() {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const renders = useRef<{ main: boolean; calls: number; tris: number }[]>([]);
  const started = useRef(0);
  const frames = useRef(0);
  const cameraRef = useRef<THREE.Camera>(camera);
  cameraRef.current = camera;

  useEffect(() => {
    gl.info.autoReset = false;
    const prev = scene.onAfterRender;
    scene.onAfterRender = function (renderer, sc, cam, geometry, material, group) {
      renders.current.push({ main: cam === cameraRef.current, calls: gl.info.render.calls, tris: gl.info.render.triangles });
      prev.call(this, renderer, sc, cam, geometry, material, group);
    };
    return () => {
      gl.info.autoReset = true;
      scene.onAfterRender = prev;
    };
  }, [gl, scene]);

  useFrame(() => {
    gl.info.reset();
    renders.current.length = 0;
    started.current = performance.now();
  }, -1000);

  useFrame(() => {
    let prevC = 0;
    let prevT = 0;
    let sceneCalls = 0;
    let sceneTris = 0;
    let reflCalls = 0;
    let reflTris = 0;
    for (const r of renders.current) {
      const dc = r.calls - prevC;
      const dt = r.tris - prevT;
      if (r.main) {
        sceneCalls += dc;
        sceneTris += dt;
      } else {
        reflCalls += dc;
        reflTris += dt;
      }
      prevC = r.calls;
      prevT = r.tris;
    }
    frames.current++;
    window.__cityStats = {
      calls: gl.info.render.calls,
      sceneCalls,
      reflectionCalls: reflCalls,
      postCalls: gl.info.render.calls - prevC,
      triangles: gl.info.render.triangles,
      sceneTriangles: sceneTris,
      reflectionTriangles: reflTris,
      cpuMs: performance.now() - started.current,
      frames: frames.current,
    };
  }, 1000);
  return null;
}
