import type * as THREE from "three";

/**
 * Per-floor light levels for a hero tower. Floors are split bottom-to-top into
 * `bands` equal groups; bands [0, activeBands) are lit. When a band switches
 * on, its floors light one after another (an upward sweep, ~75 ms per floor);
 * when it switches off they fade from the top down. Levels are written into a
 * 1-pixel-high data texture the window shader samples by floor index.
 */
export class FloorAnimator {
  private readonly levels: Float32Array;
  private readonly targets: Float32Array;
  private readonly delays: Float32Array;
  private bands = -1;
  private active = -1;
  private dirty = true;

  constructor(
    private readonly texture: THREE.DataTexture,
    readonly floors: number,
  ) {
    this.levels = new Float32Array(floors);
    this.targets = new Float32Array(floors);
    this.delays = new Float32Array(floors);
  }

  private bandOf(f: number, bands: number): number {
    return Math.min(bands - 1, Math.floor((f * bands) / this.floors));
  }

  private bandStart(b: number, bands: number): number {
    return Math.ceil((b * this.floors) / bands);
  }

  setTargets(bands: number, activeBands: number) {
    bands = Math.max(0, Math.floor(bands));
    activeBands = Math.max(0, Math.min(bands, Math.floor(activeBands)));
    if (bands === this.bands && activeBands === this.active) return;
    this.bands = bands;
    this.active = activeBands;
    for (let f = 0; f < this.floors; f++) {
      const b = bands > 0 ? this.bandOf(f, bands) : 0;
      const t = bands > 0 && b < activeBands ? 1 : 0;
      if (t !== this.targets[f]) {
        this.targets[f] = t;
        if (bands > 0) {
          const start = this.bandStart(b, bands);
          const end = this.bandStart(b + 1, bands) - 1;
          this.delays[f] = t === 1 ? (f - start) * 0.075 : (end - f) * 0.035;
        }
      }
    }
    this.dirty = true;
  }

  update(dt: number) {
    if (!this.dirty) return;
    let moving = false;
    const data = this.texture.image.data as Uint8Array;
    for (let f = 0; f < this.floors; f++) {
      const d = this.delays[f]!;
      if (d > 0) {
        this.delays[f] = d - dt;
        moving = true;
        continue;
      }
      const cur = this.levels[f]!;
      const tgt = this.targets[f]!;
      if (cur !== tgt) {
        const step = tgt > cur ? dt * 5 : dt * 3;
        const next = tgt > cur ? Math.min(tgt, cur + step) : Math.max(tgt, cur - step);
        this.levels[f] = next;
        data[f * 4] = Math.round(next * 255);
        moving = true;
      }
    }
    this.texture.needsUpdate = true;
    this.dirty = moving;
  }
}
