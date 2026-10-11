// Generates the station avatars as animated GIFs from the bloub engine
// (https://github.com/jeremy-prt/bloub, MIT, © Jérémy Perret).
//
// One GIF per (body shape × role colour × state). The engine is a pure function of
// time, so each frame is `engine.sample(t)` rendered to SVG exactly like bloub's
// BloubBot.vue, rasterised on a canvas in headless Chrome and packed with bloub's own
// GIF encoder (src/ui/anime.ts). Output: ui/public/bots/*.gif + manifest.json.
//
// Usage: node scripts/bots/make-gifs.mjs --bloub=/path/to/bloub [--size=128]
// Alternatively provide the source checkout through BLOUB_ROOT.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "rolldown";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=") ?? d;
const sourceRoot = arg("bloub", process.env.BLOUB_ROOT ?? "");
if (!sourceRoot.trim()) throw new Error("Provide --bloub=<source-checkout> or BLOUB_ROOT before regenerating avatars.");
const BLOUB = path.resolve(sourceRoot);
if (!fs.existsSync(path.join(BLOUB, "src")) || !fs.existsSync(path.join(BLOUB, "LICENSE"))) throw new Error("The configured bloub checkout must contain src and LICENSE.");
const SIZE = Number(arg("size", 96));
const OUT = path.join(ROOT, "ui/public/bots");
const FPS = 20, SECONDS = 3;

/* ---------------------------------------------------------------- what to draw */

// Our shape names → bloub's measured silhouettes.
export const SHAPE_MAP = { circle: "cercle", squircle: "squircle", drop: "goutte", capsule: "capsule", star: "nuage", hex: "hexagone", bean: "galet" };
// Station states (Spec §10.4). Only bloub's resting state keeps the chosen body, so every
// station state is that state with one of bloub's measured expressions; "work" also
// sweeps the gaze left and right so a busy station visibly looks around.
export const STATE_MAP = {
  idle: { expression: "neutre" },
  work: { expression: "attentif", scan: true },
  wait: { expression: "blase" },
  returned: { expression: "confus" },
  fail: { expression: "effraye" },
  sleep: { expression: "somnolent" },
};

function oklchToHex(L, C, H) {
  const h = (H * Math.PI) / 180, a = C * Math.cos(h), b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b, m_ = L - 0.1055613458 * a - 0.0638541728 * b, s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  return "#" + lin.map((v) => { const c = Math.max(0, Math.min(1, v)); const g = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055; return Math.round(g * 255).toString(16).padStart(2, "0"); }).join("");
}

const { pack } = await import(new URL("../../packs/vislexicon/pack.ts", import.meta.url).href);
const { compile } = await import(new URL("../../server/spec/compile.ts", import.meta.url).href);
const { ROLE_HUES } = await import(new URL("../../shared/palette.ts", import.meta.url).href);
const factory = compile([pack]);

// Body colour per role: the role hue, a little deeper than the card border so the bot reads on the tinted fill.
const roleInk = Object.fromEntries(Object.entries(ROLE_HUES).map(([role, { h, c }]) => [role, c === 0 ? "#5b5a55" : oklchToHex(0.6, Math.min(0.17, c * 1.25), h)]));

const wired = new Set(factory.lines.filter((l) => l.wired).map((l) => l.id));
const combos = new Map();
for (const n of factory.nodes) {
  const shape = SHAPE_MAP[n.bot.shape] ?? "cercle";
  const key = `${shape}-${n.role}`;
  const runs = wired.has(n.line) && !n.dormant && n.kind !== "source";
  const prev = combos.get(key);
  const states = new Set([...(prev?.states ?? []), ...(runs ? ["idle", "work", "wait", "returned", "fail", "sleep"] : ["idle", "sleep"])]);
  combos.set(key, { shape, role: n.role, ink: roleInk[n.role], states: [...states] });
}
// The dispatcher's own avatar: bloub's original ink-black ball.
combos.set("cercle-dispatcher", { shape: "cercle", role: "dispatcher", ink: "#1d1d1a", states: ["idle", "work"] });

/* ---------------------------------------------------------------- bundle the engine */

const bundle = await build({
  input: path.join(ROOT, "scripts/bots/entry.ts"),
  resolve: { alias: { "@": path.join(BLOUB, "src") } },
  output: { format: "iife", name: "Bloub" },
  write: false,
});
const code = bundle.output[0].code;

/* ---------------------------------------------------------------- render in Chrome */

const exe = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find((p) => fs.existsSync(p));
const browser = await chromium.launch({ headless: true, executablePath: exe });
const page = await browser.newPage();
await page.setContent("<!doctype html><html><body></body></html>");
await page.addScriptTag({ content: code });
await page.addScriptTag({
  content: `
window.renderGif = async function (job) {
  const B = window.Bloub, VB = B.DEMI_VIEWBOX, R = B.RAYON, paper = "#ffffff";
  const radii = B.SHAPE_BY_ID.get(job.shape)?.radii ?? null;
  const engine = new B.BotEngine(R, "idle", radii, B.EXPRESSION_BY_ID.get(job.expression) ?? null);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = job.size;
  const ctx = canvas.getContext("2d");
  const frames = [];
  const n = job.fps * job.seconds;
  for (let i = 0; i < n; i++) {
    const t = i / job.fps;
    if (job.scan && i % Math.round(job.fps * 0.75) === 0) {
      const k = Math.round(t / 0.75) % 4;
      engine.setLook({ yaw: [-30, 0, 30, 0][k], pitch: [8, -6, 8, 18][k], mix: 1, spin: 0, wander: 0.4 }, t);
    }
    const f = engine.sample(t);
    const dot = (d) => {
      const fill = d.color ?? (d.depth === undefined ? job.ink : B.mixHex(paper, job.ink, d.depth));
      return d.d ? '<path d="' + d.d + '" fill="' + fill + '" opacity="' + d.opacity + '" transform="translate(' + d.x + ' ' + d.y + ') rotate(' + (d.rot ?? 0) + ') scale(' + R + ')"/>'
                 : '<circle cx="' + d.x + '" cy="' + d.y + '" r="' + d.r + '" fill="' + fill + '" opacity="' + d.opacity + '"/>';
    };
    const grads = f.arcs.map((a) => '<linearGradient id="g' + a.id + '" gradientUnits="userSpaceOnUse" x1="' + a.grad.x1 + '" y1="' + a.grad.y1 + '" x2="' + a.grad.x2 + '" y2="' + a.grad.y2 + '">' +
      a.grad.stops.map((c, k) => '<stop offset="' + (k / (a.grad.stops.length - 1)) + '" stop-color="' + c + '"/>').join("") + '</linearGradient>').join("");
    const arcs = (side) => '<g fill="none" stroke-linecap="round">' + f.arcs.map((a) => '<path d="' + a[side] + '" stroke="url(#g' + a.id + ')" stroke-width="' + a.width + '" opacity="' + a.opacity + '"/>').join("") + '</g>';
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + job.size + '" height="' + job.size + '" viewBox="' + (-VB) + ' ' + (-VB) + ' ' + (VB * 2) + ' ' + (VB * 2) + '"><defs>' +
      '<mask id="m" maskUnits="userSpaceOnUse" x="' + (-VB) + '" y="' + (-VB) + '" width="' + (VB * 2) + '" height="' + (VB * 2) + '"><path d="' + f.bodyPath + '" fill="#fff"/>' +
      f.eyes.map((e) => '<path d="' + e.d + '" transform="' + e.matrix + '" opacity="' + e.alpha + '" fill="#000"/>').join("") +
      (f.notch ? '<circle cx="' + f.notch.x + '" cy="' + f.notch.y + '" r="' + f.notch.r + '" fill="#000"/>' : "") + '</mask>' + grads + '</defs>' +
      arcs("back") + (f.dotsBehind ? f.dots.map(dot).join("") : "") +
      '<g opacity="' + f.bodyAlpha + '"><path d="' + f.bodyPath + '" fill="' + paper + '"/><g mask="url(#m)"><rect x="' + (-VB) + '" y="' + (-VB) + '" width="' + (VB * 2) + '" height="' + (VB * 2) + '" fill="' + job.ink + '"/></g></g>' +
      (!f.dotsBehind ? f.dots.map(dot).join("") : "") +
      (f.notif ? '<circle cx="' + f.notif.x + '" cy="' + f.notif.y + '" r="' + f.notif.r + '" fill="' + B.NOTIF_BLUE + '"/>' : "") +
      arcs("front") + '</svg>';
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    const img = new Image();
    img.src = url;
    await img.decode();
    ctx.clearRect(0, 0, job.size, job.size);
    ctx.drawImage(img, 0, 0, job.size, job.size);
    URL.revokeObjectURL(url);
    frames.push(ctx.getImageData(0, 0, job.size, job.size).data);
  }
  const gif = B.gifAnime(frames, job.size, job.size, Math.round(1000 / job.fps));
  let s = "";
  for (let i = 0; i < gif.length; i += 0x8000) s += String.fromCharCode.apply(null, gif.subarray(i, i + 0x8000));
  return btoa(s);
};`,
});

fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) if (f.endsWith(".gif")) fs.rmSync(path.join(OUT, f));
let bytes = 0, count = 0;
const t0 = Date.now();
for (const [key, c] of combos) {
  for (const ours of c.states) {
    const st = STATE_MAP[ours];
    const b64 = await page.evaluate((job) => window.renderGif(job), { shape: c.shape, expression: st.expression, scan: Boolean(st.scan), ink: c.ink, size: SIZE, fps: FPS, seconds: SECONDS });
    const buf = Buffer.from(b64, "base64");
    fs.writeFileSync(path.join(OUT, `${key}-${ours}.gif`), buf);
    bytes += buf.length; count++;
  }
}
await browser.close();
const manifest = {
  source: "https://github.com/jeremy-prt/bloub (MIT, © 2026 Jérémy Perret) — avatars rendered from its engine",
  size: SIZE, fps: FPS, seconds: SECONDS, shapes: SHAPE_MAP, states: STATE_MAP, roleInk,
  combos: Object.fromEntries([...combos].map(([k, c]) => [k, c.states])),
};
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
fs.writeFileSync(path.join(OUT, "LICENSE-bloub.txt"), fs.readFileSync(path.join(BLOUB, "LICENSE"), "utf8"));
console.log(`${count} GIFs, ${(bytes / 1024 / 1024).toFixed(2)} MB, ${combos.size} combos, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
