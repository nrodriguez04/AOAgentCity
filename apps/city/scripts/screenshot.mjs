// Headless screenshots of the city for visual review.
//   node scripts/screenshot.mjs <url> <out.png> [--wait 6000] [--width 1600] [--height 1000] [--eval "js"]
// Uses Playwright's Chromium with SwiftShader WebGL (no GPU needed). Set
// PLAYWRIGHT_MODULE to a playwright install if `playwright` is not resolvable.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? "playwright");

const [url, out, ...rest] = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : fallback;
};
if (!url || !out) {
  console.error("usage: node scripts/screenshot.mjs <url> <out.png> [--wait ms] [--width px] [--height px] [--eval js]");
  process.exit(1);
}

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: Number(opt("width", 1600)), height: Number(opt("height", 1000)) } });
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") errors.push(`${m.type()}: ${m.text()}`);
});
await page.goto(url, { waitUntil: "load", timeout: 120_000 });
await page.waitForTimeout(Number(opt("wait", 6000)));
const script = opt("eval", null);
if (script) {
  await page.evaluate(script);
  await page.waitForTimeout(Number(opt("after", 1500)));
}
await page.screenshot({ path: out });
console.log(`saved ${out}`);
if (errors.length) console.log(errors.slice(0, 30).join("\n"));
await browser.close();
