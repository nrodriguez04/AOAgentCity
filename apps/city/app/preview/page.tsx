import type { Metadata } from "next";
import PreviewClient from "./PreviewClient";

export const metadata: Metadata = {
  title: "Agent City · scene preview",
};

type SearchParams = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

// Dev preview of the 3D city with mock BuildingVisuals covering every state.
//   ?low=1  ?paused=1  ?traffic=0..1  ?focus=<divisionId>  ?insets=1  ?stats=1  ?select=<divisionId>
//   ?fps=N caps the frame rate (useful for software-rendered screenshots).
//   ?cam=px,py,pz,tx,ty,tz starts the camera at a given pose.
//   ?flash=hold keeps the run.succeeded flash frozen mid-way up the building.
export default async function PreviewPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const traffic = Number(first(sp.traffic));
  const fps = Number(first(sp.fps));
  const cam = (first(sp.cam) ?? "").split(",").map(Number);
  return (
    <PreviewClient
      low={first(sp.low) === "1"}
      paused={first(sp.paused) === "1"}
      traffic={Number.isFinite(traffic) ? Math.min(1, Math.max(0, traffic)) : 0.6}
      focus={first(sp.focus) ?? null}
      select={first(sp.select) ?? null}
      insets={first(sp.insets) === "1"}
      stats={first(sp.stats) === "1"}
      fps={Number.isFinite(fps) && fps > 0 ? fps : 0}
      cam={cam.length === 6 && cam.every(Number.isFinite) ? cam : null}
      flashHold={first(sp.flash) === "hold"}
    />
  );
}
