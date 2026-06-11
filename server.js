import "./env.js"; // loads .env.local first: other modules read env (AF_SEASON, key) at import time
import express from "express";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { predict, predictNations, loadPredictor, unloadModel, funFactsRewrite, LLM } from "./engine.js";
import { refresh, getFixtures, ratingFor, getLeagueAvg, allTeams, isPlaceholderTeam } from "./data.js";
import { simulateMatch } from "./simulate.js";
import { squadScored, teamRecap, teamDescription, teamRating, readManifest } from "./data-apifootball.js";
import { getGroups, getSchedule, getKnockout, simulateTournament, simulateTournamentStream } from "./tournament.js";

const POS_ORDER = { GK: 0, DEF: 1, MID: 2, FWD: 3 };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3060;
const totalRamGB = os.totalmem() / 1024 ** 3;
const MODEL_KEY = process.env.PREDICTOR_SMALL || totalRamGB < 12 ? "small" : "big"; // 1.7B on tight machines
const MODEL_NAME = MODEL_KEY === "big" ? "Qwen3 4B" : "Qwen3 1.7B";

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

let state = { modelId: null, loading: null };
async function ensureModel() {
  if (state.modelId) return state.modelId;
  if (state.loading) return state.loading;
  if (totalRamGB < 7) throw new Error(`This machine has ${totalRamGB.toFixed(0)} GB RAM; need ~8 GB.`);
  state.loading = loadPredictor(MODEL_KEY).then((id) => { state.modelId = id; return id; });
  return state.loading;
}

app.post("/api/predict", async (req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  try {
    const teamA = String(req.body.team_a || "Team A").slice(0, 40);
    const teamB = String(req.body.team_b || "Team B").slice(0, 40);
    // If both teams have cached player data, use the grounded player-level analysis;
    // otherwise fall back to the tournament-history (openfootball) prediction.
    const man = readManifest();
    const haveA = Object.keys(man).some((n) => n.toLowerCase() === teamA.toLowerCase());
    const haveB = Object.keys(man).some((n) => n.toLowerCase() === teamB.toLowerCase());
    const usePlayers = haveA && haveB;
    send({ type: "status", text: `Loading ${MODEL_NAME} on-device...`, model: MODEL_NAME, mode: usePlayers ? "players" : "history" });
    const modelId = await ensureModel();
    send({ type: "status", text: usePlayers ? "Analyzing the squads..." : "Analyzing...", started: true });
    const tone = req.body.tone === "fun" ? "fun" : undefined;
    if (usePlayers) await predictNations({ modelId, teamA, teamB, tone, onEvent: (e) => send(e) });
    else await predict({ modelId, teamA, teamB, onEvent: (e) => send(e) });
    send({ type: "done" });
    res.end();
  } catch (err) {
    send({ type: "error", message: err.message || String(err) });
    res.end();
  }
});

app.get("/api/fixtures", async (_req, res) => {
  try { await refresh(); res.json(getFixtures().filter((m) => !m.score && !isPlaceholderTeam(m.team_a) && !isPlaceholderTeam(m.team_b))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Every team + its stats, sorted strong to weak. No model needed.
app.get("/api/teams", async (_req, res) => {
  try { await refresh(); res.json(allTeams()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Instant Monte Carlo for ANY two teams. No model, no AI: pure simulation, returns
// immediately. Powers the self-serve "Stats & Simulator" section.
app.get("/api/simulate", async (req, res) => {
  try {
    await refresh();
    const a = String(req.query.a || "").slice(0, 40), b = String(req.query.b || "").slice(0, 40);
    if (!a || !b) return res.status(400).json({ error: "need query params a and b" });
    res.json({ team_a: a, team_b: b, rating_a: ratingFor(a), rating_b: ratingFor(b), ...simulateMatch(ratingFor(a), ratingFor(b), getLeagueAvg()) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- National-team player-level data (API-Football, cached on disk; no API spend here) ---
app.get("/api/nations", (_req, res) => {
  const m = readManifest();
  res.json(Object.entries(m).map(([name, info]) => ({ name, ...info })).sort((a, b) => a.name.localeCompare(b.name)));
});
app.get("/api/nation", async (req, res) => {
  try {
    const name = String(req.query.name || "");
    const scored = await squadScored(name, { allowFetch: false });
    if (!scored.found || !scored.players.length) return res.status(404).json({ error: "not cached yet", name });
    const players = [...scored.players].sort((a, b) => (POS_ORDER[a.pos] - POS_ORDER[b.pos]) || b.rating - a.rating);
    res.json({ team: scored.team, complete: scored.missing.length === 0, missing: scored.missing.length, description: teamDescription(scored), recap: teamRecap(scored), rating: teamRating(scored), players });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/players-pool", async (_req, res) => {
  try {
    const m = readManifest();
    const pool = [];
    for (const name of Object.keys(m)) {
      const s = await squadScored(name, { allowFetch: false });
      for (const p of s.players) pool.push({ id: p.id, name: p.name, team: name, pos: p.pos, age: p.age, minutes: p.minutes, rating: p.rating, attack: p.attack, defense: p.defense, technique: p.technique, endurance: p.endurance, injury_risk: p.injury_risk, overall: p.overall, goals: p.goals, assists: p.assists });
    }
    res.json(pool);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Fixtures, groups, bracket (openfootball; ?refresh=1 FORCES a re-pull for live scores) ---
app.get("/api/schedule", async (req, res) => {
  try {
    await refresh(!!req.query.refresh);
    res.json({ groups: getGroups(), schedule: getSchedule(), knockout: getKnockout(), cached: Object.keys(readManifest()) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Simulate the whole tournament (Monte Carlo) -> one consistent result: per-team odds, the
// PREDICTED tournament played match-by-match (most-likely champion wins it, favourites advance),
// the most-seen finals, and fun facts mined from the runs. The UI paces the reveal. ---
app.get("/api/simulate-tournament", async (req, res) => {
  const runs = Math.min(10000, Math.max(500, Number(req.query.runs) || 5000));
  try { res.json(await simulateTournament(runs)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Rephrase the computed fun facts with the LOCAL LLM (numbers validated host-side; falls
// back to null so the UI keeps the plain computed facts if the model mangles anything). ---
app.post("/api/cup-facts", async (req, res) => {
  try {
    const facts = Array.isArray(req.body?.facts) ? req.body.facts.map(String).slice(0, 8) : [];
    if (!facts.length) return res.status(400).json({ error: "facts required" });
    const modelId = await ensureModel();
    const out = await funFactsRewrite({ modelId, facts });
    res.json({ facts: out || null, ai: !!out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function shutdown() { if (state.modelId) await unloadModel({ modelId: state.modelId, clearStorage: false }).catch(() => {}); process.exit(0); }
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
app.listen(PORT, () => console.log(`[predictor] http://localhost:${PORT}  (model: ${MODEL_NAME}, RAM ${totalRamGB.toFixed(0)} GB)`));
