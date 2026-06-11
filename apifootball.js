// API-Football (api-sports.io) client with an on-disk cache + precise daily-budget
// tracking. Works on any plan: the daily budget is read from the
// `x-ratelimit-requests-remaining` response header (exact, not guessed) and the
// per-minute throttle adapts to the `x-ratelimit-remaining` header, so a paid plan
// (e.g. 7500/day, 300/min) runs near full speed while the free plan stays at one
// call per ~7s. Reads hit the cache; only genuine misses spend a request.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = "https://v3.football.api-sports.io";
const CACHE_DIR = path.join(__dirname, "cache", "af");
const BUDGET_FILE = path.join(CACHE_DIR, "_budget.json");
const KEY = () => process.env.APIFOOTBALL_KEY || "";
// Never spend the last N requests of the day (manual predicts must keep working).
const SAFE_MARGIN = Number(process.env.AF_SAFE_MARGIN) || 3;
// Per-minute throttle: adaptive. Until we have seen a per-minute header we pace
// conservatively; once we know the window has room we go near full speed.
let minuteRemaining = null; // from `x-ratelimit-remaining` (per-minute) on the last response
let lastFetch = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function gapMs() {
  if (process.env.AF_MIN_GAP_MS) return Number(process.env.AF_MIN_GAP_MS);
  if (minuteRemaining == null) return 1500; // unknown plan: cautious but not glacial
  if (minuteRemaining > 8) return 220;      // plenty of room in this minute window
  if (minuteRemaining > 2) return 4000;     // window nearly spent: ease off
  return 61000;                              // window exhausted: wait it out
}

fs.mkdirSync(CACHE_DIR, { recursive: true });
const todayUTC = () => new Date().toISOString().slice(0, 10);
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const writeJson = (f, o) => fs.writeFileSync(f, JSON.stringify(o));

function loadBudget() {
  const b = readJson(BUDGET_FILE, { day: todayUTC(), remaining: null });
  if (b.day !== todayUTC()) return { day: todayUTC(), remaining: null }; // reset at UTC midnight
  return b;
}
export function budget() { return loadBudget(); }

const keyFor = (p, params) => {
  const q = Object.entries(params).filter(([, v]) => v != null && v !== "").sort().map(([k, v]) => `${k}-${v}`).join("_");
  return (p.replace(/\//g, "_") + (q ? "__" + q : "")).replace(/[^a-z0-9_.-]/gi, "");
};

// GET with cache. opts: { ttlMs, allowFetch=true }. Returns { data, cached, remaining, spent, deferred }.
export async function afGet(endpoint, params = {}, opts = {}) {
  const { ttlMs = 1000 * 60 * 60 * 24 * 3, allowFetch = true } = opts;
  const file = path.join(CACHE_DIR, keyFor(endpoint, params) + ".json");
  if (fs.existsSync(file)) {
    const age = Date.now() - fs.statSync(file).mtimeMs;
    if (age < ttlMs) return { data: readJson(file), cached: true, remaining: loadBudget().remaining, spent: false, deferred: false };
  }
  if (!allowFetch) {
    const stale = fs.existsSync(file) ? readJson(file) : null;
    return { data: stale, cached: !!stale, remaining: loadBudget().remaining, spent: false, deferred: !stale };
  }
  const b = loadBudget();
  if (b.remaining != null && b.remaining <= SAFE_MARGIN) {
    const stale = fs.existsSync(file) ? readJson(file) : null;
    return { data: stale, cached: !!stale, remaining: b.remaining, spent: false, deferred: true }; // out of budget today
  }
  if (!KEY()) throw new Error("APIFOOTBALL_KEY not set (use: node --env-file=.env.local ...)");

  const url = `${BASE}${endpoint}?` + new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== "")));
  // Throttle to respect the per-minute cap (adaptive to the plan, see gapMs).
  const since = Date.now() - lastFetch;
  const gap = gapMs();
  if (since < gap) await sleep(gap - since);
  lastFetch = Date.now();
  const res = await fetch(url, { headers: { "x-apisports-key": KEY() } });
  // Only trust the daily-remaining header when it is genuinely present + numeric.
  // (A missing header -> Number(null)===0, which previously corrupted the budget to 0.)
  const h = res.headers.get("x-ratelimit-requests-remaining");
  const remaining = h != null && h !== "" && !Number.isNaN(Number(h)) ? Number(h) : null;
  if (remaining != null) writeJson(BUDGET_FILE, { day: todayUTC(), remaining });
  const hm = res.headers.get("x-ratelimit-remaining"); // per-minute window
  if (hm != null && hm !== "" && !Number.isNaN(Number(hm))) minuteRemaining = Number(hm);
  const json = await res.json();
  const hasErr = Array.isArray(json.errors) ? json.errors.length : json.errors && Object.keys(json.errors).length;
  if (hasErr) {
    const msg = JSON.stringify(json.errors);
    // Per-minute rate limit: wait out the window and retry once.
    if (/ratelimit|too many requests/i.test(msg) && !opts._retry) { await sleep(61000); return afGet(endpoint, params, { ...opts, _retry: true }); }
    throw new Error(`API-Football error: ${msg}`);
  }
  writeJson(file, json.response);
  return { data: json.response, cached: false, remaining: remaining ?? loadBudget().remaining, spent: true, deferred: false };
}

// Read-only: return cached data if present (any age), else null. Never spends a request.
export function afCached(endpoint, params = {}) {
  const file = path.join(CACHE_DIR, keyFor(endpoint, params) + ".json");
  return fs.existsSync(file) ? readJson(file) : null;
}

// Probe /status DIRECTLY (no cache, no budget gate): refreshes the budget file from the
// live headers. Essential after a plan upgrade, when the on-disk budget is stale-low and
// would otherwise wrongly defer every call. /status does not count against the quota.
export async function afStatus() {
  if (!KEY()) throw new Error("APIFOOTBALL_KEY not set");
  const res = await fetch(`${BASE}/status`, { headers: { "x-apisports-key": KEY() } });
  const h = res.headers.get("x-ratelimit-requests-remaining");
  const remaining = h != null && h !== "" && !Number.isNaN(Number(h)) ? Number(h) : null;
  if (remaining != null) writeJson(BUDGET_FILE, { day: todayUTC(), remaining });
  const hm = res.headers.get("x-ratelimit-remaining");
  if (hm != null && hm !== "" && !Number.isNaN(Number(hm))) minuteRemaining = Number(hm);
  const json = await res.json().catch(() => ({}));
  const sub = json?.response?.subscription || {};
  const req = json?.response?.requests || {};
  return { plan: sub.plan || "?", active: sub.active, used: req.current ?? null, limitDay: req.limit_day ?? null, remaining };
}

// Manifest of cached nations (so the UI can browse what's available without API calls).
const MANIFEST_FILE = path.join(CACHE_DIR, "_nations.json");
export function readManifest() { return readJson(MANIFEST_FILE, {}); }
export function updateManifest(name, info) {
  const m = readManifest();
  m[name] = { ...info, updated: todayUTC() };
  writeJson(MANIFEST_FILE, m);
}
