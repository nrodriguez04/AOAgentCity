import * as THREE from "three";
import type { DisplayLine } from "@/lib/visual-types";

// Canvas-driven displays: the ParlayLab LED ticker band and the CreatorOS
// billboards. Text uses system monospace so nothing is fetched at runtime.

const MONO = "ui-monospace, 'DejaVu Sans Mono', 'Liberation Mono', Menlo, monospace";
const SANS = "system-ui, 'DejaVu Sans', 'Liberation Sans', Helvetica, Arial, sans-serif";

const TONE_COLOR = { up: "#4dff9a", down: "#ff5a5f", neutral: "#f4f6ff" } as const;

function canvasTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

function arrow(tone: DisplayLine["tone"]): string {
  return tone === "up" ? "▲" : tone === "down" ? "▼" : "•";
}

/** Horizontal LED ticker: u runs 0..1 around the band; scrolling via texture offset. */
export class LedTicker {
  readonly canvas: HTMLCanvasElement;
  readonly texture: THREE.CanvasTexture;
  private key = "";

  /** aspect: band length / band height, so glyphs keep their proportions on the building. */
  constructor(
    private readonly title: string,
    aspect = 12,
  ) {
    const width = 2048;
    this.canvas = document.createElement("canvas");
    this.canvas.width = width;
    this.canvas.height = Math.round(THREE.MathUtils.clamp(width / Math.max(1, aspect), 40, 256));
    this.texture = canvasTexture(this.canvas);
    this.texture.wrapS = THREE.RepeatWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.draw([]);
  }

  draw(lines: DisplayLine[]) {
    const key = JSON.stringify(lines);
    if (key === this.key) return;
    this.key = key;
    const { canvas } = this;
    const ctx = canvas.getContext("2d")!;
    const W = canvas.width;
    const H = canvas.height;
    ctx.fillStyle = "#030303";
    ctx.fillRect(0, 0, W, H);
    const items =
      lines.length > 0
        ? lines.map((l) => ({ label: l.label.toUpperCase(), value: l.value, tone: l.tone ?? "neutral" }))
        : [{ label: this.title.toUpperCase(), value: "STANDING BY", tone: "neutral" as const }];
    ctx.font = `700 ${Math.round(H * 0.74)}px ${MONO}`;
    ctx.textBaseline = "middle";
    // Lay the items out once, then repeat to fill the band seamlessly.
    const segs: { text: string; color: string }[] = [];
    for (const it of items) {
      segs.push({ text: "◆ ", color: "#ff9d2e" });
      segs.push({ text: `${it.label} `, color: "#ffb547" });
      segs.push({ text: `${it.value} ${arrow(it.tone)}`, color: TONE_COLOR[it.tone] });
      segs.push({ text: "    ", color: "#000" });
    }
    const unit = segs.reduce((s, g) => s + ctx.measureText(g.text).width, 0);
    const reps = Math.max(1, Math.floor(W / Math.max(unit, 1)));
    const scale = W / (unit * reps);
    ctx.save();
    ctx.scale(scale, 1);
    let x = 0;
    for (let r = 0; r < reps; r++) {
      for (const g of segs) {
        ctx.fillStyle = g.color;
        ctx.fillText(g.text, x, H * 0.54);
        x += ctx.measureText(g.text).width;
      }
    }
    ctx.restore();
    // LED dot matrix.
    const pitch = Math.max(3, Math.round(H / 26));
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    for (let y = 0; y < H; y += pitch) ctx.fillRect(0, y, W, 1);
    for (let xx = 0; xx < W; xx += pitch) ctx.fillRect(xx, 0, 1, H);
    // Thin frame rails.
    ctx.fillStyle = "#1a1a1a";
    ctx.fillRect(0, 0, W, Math.max(2, H * 0.05));
    ctx.fillRect(0, H - Math.max(2, H * 0.05), W, Math.max(2, H * 0.05));
    this.texture.needsUpdate = true;
  }

  scroll(dt: number) {
    this.texture.offset.x = (this.texture.offset.x + dt * 0.018) % 1;
  }

  dispose() {
    this.texture.dispose();
  }
}

export type ScreenKind = "metric" | "ticker" | "orbs" | "stripes" | "wave" | "mosaic";

const AD_WORDS = ["LIVE", "NOW", "24/7", "NEW", "CREATE", "PLAY", "GO", "WOW"];
const AD_COLORS = [
  ["#ff2d55", "#ffb000"],
  ["#00c2ff", "#7a00ff"],
  ["#ff00a8", "#00ffd5"],
  ["#ffe600", "#ff3d00"],
  ["#00ff88", "#0066ff"],
  ["#ffffff", "#ff2d55"],
] as const;

const METRIC_GRADIENTS = [
  ["#2b0057", "#a1005c", "#ff6a00"],
  ["#00163d", "#0050b3", "#00d4ff"],
  ["#1f0033", "#6a00f4", "#ff2d95"],
  ["#002b1f", "#008f5a", "#c6ff3d"],
] as const;

/** One billboard face. Redrawn a few times per second. */
export class ScreenPainter {
  readonly canvas: HTMLCanvasElement;
  readonly texture: THREE.CanvasTexture;
  private lastDraw = -1;

  constructor(
    readonly kind: ScreenKind,
    readonly seed: number,
    aspect: number,
    private readonly title: string,
  ) {
    const w = aspect >= 1 ? 512 : Math.round(512 * aspect);
    const h = aspect >= 1 ? Math.round(512 / aspect) : 512;
    this.canvas = document.createElement("canvas");
    this.canvas.width = Math.max(64, w);
    this.canvas.height = Math.max(64, h);
    this.texture = canvasTexture(this.canvas);
  }

  update(t: number, lines: DisplayLine[], fps = 6) {
    if (this.lastDraw >= 0 && t - this.lastDraw < 1 / fps) return;
    this.lastDraw = t;
    const ctx = this.canvas.getContext("2d")!;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const palette = AD_COLORS[this.seed % AD_COLORS.length]!;
    ctx.save();
    switch (this.kind) {
      case "metric":
        this.drawMetric(ctx, W, H, t, lines);
        break;
      case "ticker":
        this.drawTicker(ctx, W, H, t, lines);
        break;
      case "orbs": {
        const g = ctx.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, palette[1]);
        g.addColorStop(1, "#14002e");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
        for (let i = 0; i < 6; i++) {
          const px = (Math.sin(t * (0.4 + i * 0.13) + i * 2.1) * 0.4 + 0.5) * W;
          const py = (Math.cos(t * (0.33 + i * 0.07) + i) * 0.35 + 0.5) * H;
          const r = (0.12 + 0.08 * Math.sin(t + i)) * Math.min(W, H);
          const rg = ctx.createRadialGradient(px, py, 0, px, py, r);
          rg.addColorStop(0, i % 2 ? palette[0] : "#ffffff");
          rg.addColorStop(1, "rgba(0,0,0,0)");
          ctx.fillStyle = rg;
          ctx.beginPath();
          ctx.arc(px, py, r, 0, Math.PI * 2);
          ctx.fill();
        }
        this.word(ctx, W, H, AD_WORDS[(this.seed + Math.floor(t / 4)) % AD_WORDS.length]!, "#ffffff");
        break;
      }
      case "stripes": {
        ctx.fillStyle = palette[0];
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = palette[1];
        const step = Math.max(W, H) / 7;
        const off = (t * 40) % (step * 2);
        ctx.translate(-H, 0);
        for (let x = -step * 2 + off; x < W + H * 2; x += step * 2) {
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x + step, 0);
          ctx.lineTo(x + step + H, H);
          ctx.lineTo(x + H, H);
          ctx.fill();
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.word(ctx, W, H, AD_WORDS[(this.seed * 3 + Math.floor(t / 5)) % AD_WORDS.length]!, "#0a0a0a", true);
        break;
      }
      case "wave": {
        ctx.fillStyle = "#050014";
        ctx.fillRect(0, 0, W, H);
        for (let k = 0; k < 5; k++) {
          ctx.strokeStyle = k % 2 ? palette[0] : palette[1];
          ctx.lineWidth = Math.max(4, H * 0.05);
          ctx.beginPath();
          for (let x = 0; x <= W; x += 8) {
            const y = H * (0.2 + k * 0.15) + Math.sin(x * 0.02 + t * 2 + k) * H * 0.07;
            if (x === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
        break;
      }
      case "mosaic": {
        const n = 8;
        const cw = W / n;
        const ch = H / Math.max(2, Math.round((n * H) / W));
        for (let y = 0; y < H; y += ch) {
          for (let x = 0; x < W; x += cw) {
            const r = Math.sin(x * 12.9898 + y * 78.233 + Math.floor(t * 2) * 3.1) * 43758.5453;
            const f = r - Math.floor(r);
            ctx.fillStyle = f > 0.66 ? palette[0] : f > 0.33 ? palette[1] : "#101018";
            ctx.fillRect(x + 1, y + 1, cw - 2, ch - 2);
          }
        }
        break;
      }
    }
    ctx.restore();
    this.texture.needsUpdate = true;
  }

  private word(ctx: CanvasRenderingContext2D, W: number, H: number, text: string, color: string, boxed = false) {
    ctx.font = `900 ${Math.round(Math.min(H * 0.42, (W / Math.max(3, text.length)) * 1.25))}px ${SANS}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (boxed) {
      const m = ctx.measureText(text);
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      ctx.fillRect(W / 2 - m.width / 2 - 14, H / 2 - H * 0.24, m.width + 28, H * 0.48);
    }
    ctx.fillStyle = color;
    ctx.fillText(text, W / 2, H / 2 + 2);
  }

  private drawMetric(ctx: CanvasRenderingContext2D, W: number, H: number, t: number, lines: DisplayLine[]) {
    const [c0, c1, c2] = METRIC_GRADIENTS[(this.seed - 1) % METRIC_GRADIENTS.length]!;
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, c0);
    g.addColorStop(0.55, c1);
    g.addColorStop(1, c2);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // Light sweep.
    const sx = ((t * 0.35) % 1.6 - 0.3) * W;
    const sg = ctx.createLinearGradient(sx - W * 0.2, 0, sx + W * 0.2, 0);
    sg.addColorStop(0, "rgba(255,255,255,0)");
    sg.addColorStop(0.5, "rgba(255,255,255,0.16)");
    sg.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = sg;
    ctx.fillRect(0, 0, W, H);
    const items = lines.length ? lines : [{ label: this.title, value: "ON AIR", tone: "neutral" as const }];
    // Offset by screen so neighbouring metric screens feature different metrics.
    const idx = (Math.floor(t / 3.5) + this.seed - 1) % items.length;
    const line = items[idx]!;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.font = `700 ${Math.round(H * 0.12)}px ${MONO}`;
    ctx.fillText(line.label.toUpperCase(), W / 2, H * 0.22);
    const valueSize = Math.min(H * 0.42, (W * 1.6) / Math.max(4, line.value.length + 2));
    ctx.font = `900 ${Math.round(valueSize)}px ${SANS}`;
    ctx.fillStyle = "#ffffff";
    ctx.shadowColor = "rgba(255,255,255,0.6)";
    ctx.shadowBlur = 18;
    ctx.fillText(line.value, W / 2, H * 0.56);
    ctx.shadowBlur = 0;
    const tone = line.tone ?? "neutral";
    ctx.font = `800 ${Math.round(H * 0.13)}px ${SANS}`;
    ctx.fillStyle = TONE_COLOR[tone];
    ctx.fillText(tone === "up" ? "▲ TRENDING UP" : tone === "down" ? "▼ DOWN" : "● LIVE", W / 2, H * 0.84);
    // Page dots.
    for (let i = 0; i < items.length; i++) {
      ctx.fillStyle = i === idx ? "#ffffff" : "rgba(255,255,255,0.35)";
      ctx.beginPath();
      ctx.arc(W / 2 + (i - (items.length - 1) / 2) * 16, H * 0.95, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawTicker(ctx: CanvasRenderingContext2D, W: number, H: number, t: number, lines: DisplayLine[]) {
    ctx.fillStyle = "#06060c";
    ctx.fillRect(0, 0, W, H);
    const items = lines.length ? lines : [{ label: this.title, value: "LIVE", tone: "neutral" as const }];
    ctx.font = `800 ${Math.round(H * 0.5)}px ${MONO}`;
    ctx.textBaseline = "middle";
    const text = items.map((l) => `${l.label.toUpperCase()} ${l.value} ${arrow(l.tone)}`).join("   ◆   ") + "   ◆   ";
    const tw = ctx.measureText(text).width;
    let x = -((t * 90) % tw);
    while (x < W) {
      let cx = x;
      for (const l of items) {
        const lab = `${l.label.toUpperCase()} `;
        ctx.fillStyle = "#ffd23f";
        ctx.fillText(lab, cx, H / 2);
        cx += ctx.measureText(lab).width;
        const val = `${l.value} ${arrow(l.tone)}`;
        ctx.fillStyle = TONE_COLOR[l.tone ?? "neutral"];
        ctx.fillText(val, cx, H / 2);
        cx += ctx.measureText(val).width;
        ctx.fillStyle = "#ff2d55";
        ctx.fillText("   ◆   ", cx, H / 2);
        cx += ctx.measureText("   ◆   ").width;
      }
      x += tw;
    }
  }

  dispose() {
    this.texture.dispose();
  }
}

/**
 * Which content each CreatorOS screen shows, by index. Every other screen carries
 * live metrics (each one featuring a different metric), so every face of the tower
 * shows real numbers between the abstract ads.
 */
export function screenKindFor(index: number, aspect: number): ScreenKind {
  if (index === 0) return "metric";
  if (aspect > 3) return "ticker";
  if (index % 2 === 0) return "metric";
  const kinds: ScreenKind[] = ["orbs", "stripes", "wave", "mosaic"];
  return kinds[Math.floor(index / 2) % kinds.length]!;
}
