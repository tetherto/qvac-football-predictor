// The predictor engine: a local LLM (Qwen3, dynamic tools, thinking ON) orchestrates
// data fetches + a Monte Carlo simulation, reasons out loud, then records a prediction.
// Shared by the server and the headless verifier.
import { loadModel, unloadModel, completion, QWEN3_4B_INST_Q4_K_M, QWEN3_1_7B_INST_Q4 } from "@qvac/sdk";
import { z } from "zod";
import { refresh, getFixtures, ratingFor, getLeagueAvg, headToHead, isPlaceholderTeam } from "./data.js";
import { simulateMatch, simulateMatchStream } from "./simulate.js";
import { squadScored, teamRating, teamRecap } from "./data-apifootball.js";
import { strengthFor } from "./strength.js";

export const LLM = { big: QWEN3_4B_INST_Q4_K_M, small: QWEN3_1_7B_INST_Q4 };
const MAX_TOOL_HOPS = 7;
let _seq = 0; // unique kvCache per prediction (reused across that run's tool hops)

// Match the model's free-text winner to a known team (case-insensitive, tolerant).
function resolveWinner(raw, teamA, teamB) {
  const w = String(raw || "").trim().toLowerCase();
  if (!w) return "Draw";
  const a = teamA.toLowerCase(), b = teamB.toLowerCase();
  const hitA = w === a || w.includes(a) || a.includes(w);
  const hitB = w === b || w.includes(b) || b.includes(w);
  return hitA && !hitB ? teamA : hitB && !hitA ? teamB : "Draw";
}
// Force the scoreline to agree with the winner (the small model often swaps the slots
// or returns a draw scoreline for a named winner). Returns [score_a, score_b].
function attributeScore(winner, teamA, teamB, sa, sb) {
  const hi = Math.max(sa, sb), lo = Math.min(sa, sb);
  if (winner === teamA) return [hi === lo ? hi + 1 : hi, lo];
  if (winner === teamB) return [lo, hi === lo ? hi + 1 : hi];
  const eq = sa === sb ? sa : Math.max(sa, sb);
  return [eq, eq]; // Draw -> equal
}

// LOCAL = computed on this machine; NETWORK = the host fetched it from the web. The
// model has no internet; a "tool call" is just the model asking the host to fetch.
export const TOOL_TAGS = {
  list_upcoming_matches: "network", get_team_profile: "network", get_head_to_head: "network",
  simulate_match: "local", make_prediction: "local",
};

export const TOOLS = [
  { name: "list_upcoming_matches", description: "List upcoming tournament fixtures (next 12).", parameters: z.object({}) },
  { name: "get_team_profile", description: "Historical tournament attack/defense strength and goals for a national team.", parameters: z.object({ team: z.string().describe("National team name, e.g. Brazil") }) },
  { name: "get_head_to_head", description: "Past tournament meetings between two national teams.", parameters: z.object({ team_a: z.string(), team_b: z.string() }) },
  { name: "simulate_match", description: "Run a 10,000-run Monte Carlo simulation grounded in the teams' ratings. Returns win/draw/loss probabilities and likely scorelines. Call this before predicting.", parameters: z.object({ team_a: z.string(), team_b: z.string() }) },
  { name: "make_prediction", description: "Record your FINAL prediction. Call exactly once, as your last action, after simulating.", parameters: z.object({
      winner: z.string().describe("Predicted winner team name, or 'Draw'"),
      score_a: z.number().int().describe("Predicted goals for the first team"),
      score_b: z.number().int().describe("Predicted goals for the second team"),
      confidence: z.enum(["low", "medium", "high"]),
      key_factors: z.array(z.string()).describe("3-5 short bullet reasons"),
    }) },
];

const SYSTEM = `You are a sharp, concise football analyst predicting a tournament match.
Work in this exact order using the tools:
1. get_team_profile for BOTH teams.
2. get_head_to_head for the pair.
3. simulate_match to get a grounded probability distribution.
4. Weigh the simulation against the profiles, then call make_prediction EXACTLY ONCE.
The simulation is your anchor: your predicted winner should match the side with the higher win probability unless you have a strong qualitative reason. Your scoreline MUST agree with your winner: the winner scores strictly more goals (e.g. 2-1), and only a "Draw" has equal scores. Pick a realistic scoreline. Keep key_factors short.
Do all your analysis in your thinking. Do not write long prose answers.`;

// One streaming turn. Emits typed events via onEvent; returns { content, toolCalls }.
async function turn({ modelId, history, kvCache, onEvent, tools = TOOLS }) {
  const run = completion({ modelId, history, tools, kvCache, stream: true, captureThinking: true });
  let content = "";
  for await (const ev of run.events) {
    if (ev.type === "contentDelta") { content += ev.text; await onEvent?.({ type: "content", text: ev.text }); }
    else if (ev.type === "thinkingDelta") await onEvent?.({ type: "thinking", text: ev.text });
    else if (ev.type === "toolCall") await onEvent?.({ type: "tool_call", name: ev.call.name, args: ev.call.arguments, tag: TOOL_TAGS[ev.call.name] || "local" });
    else if (ev.type === "completionStats") await onEvent?.({ type: "stats", stats: ev.stats });
  }
  const final = await run.final;
  return { content: final.contentText ?? content, toolCalls: final.toolCalls || [] };
}

// Normalize a make_prediction tool call into a clean, self-consistent prediction.
function buildPrediction(args, teamA, teamB) {
  let sa = parseInt(args.score_a, 10); if (!Number.isFinite(sa)) sa = 0;
  let sb = parseInt(args.score_b, 10); if (!Number.isFinite(sb)) sb = 0;
  const winner = resolveWinner(args.winner, teamA, teamB);
  [sa, sb] = attributeScore(winner, teamA, teamB, sa, sb);
  let kf = args.key_factors;
  if (typeof kf === "string") kf = kf.split(/[\n;]+|\s*[•]\s*/).map((s) => s.trim()).filter(Boolean);
  if (!Array.isArray(kf)) kf = kf ? [String(kf)] : [];
  const conf = String(args.confidence || "").toLowerCase();
  return { winner, score_a: sa, score_b: sb, confidence: ["low", "medium", "high"].includes(conf) ? conf : "medium", key_factors: kf.length ? kf.slice(0, 6) : ["(no factors given)"] };
}

const NATIONS_SYSTEM = `You are a sharp, friendly football pundit previewing a tournament match for casual fans.
You are given each team's modelled strengths and key players (from real 2024/25 club form) plus a Monte Carlo simulation. Use ONLY this data.
Write your ANSWER as a SHORT, punchy preview: exactly 3-4 sentences, plain language, no jargon, no lists, light on numbers. Say who is favoured and WHY, the key player or matchup to watch, and one X-factor or risk. Name real players from the data. Do not overthink it; write the preview directly in your answer.`;

// "Fun" mode: a sarcastic, dramatic, quotable pundit for the lite version.
const FUN_NATIONS_SYSTEM = `You are a wildly entertaining, slightly unhinged football pundit doing a hot-take preview for casual fans. You are given each team's modelled strengths and key players (real 2024/25 club form) plus a Monte Carlo simulation. Use ONLY this data, but deliver it with MAXIMUM personality.
Write your ANSWER as a SHORT, punchy preview: exactly 3-4 sentences. Be sarcastic, dramatic and emotive. Lovingly roast the underdog, hype the favourite, and name real players from the data like they are your heroes or your nemeses. Crack a joke, drop one bold quotable line. Light on numbers, heavy on vibes, no lists, no hedging. Make the reader grin.`;

// Grounded national-team prediction: uses player-derived ratings + feeds the real squad
// profiles to the model, so the analysis cites real players. Streams visible reasoning +
// a readable preview, emits the simulation (with distribution) and a structured verdict.
export async function predictNations({ modelId, teamA, teamB, onEvent, tone }) {
  const emit = (e) => onEvent?.(e);
  const sa = await squadScored(teamA, { allowFetch: false });
  const sb = await squadScored(teamB, { allowFetch: false });
  if (!sa.players.length || !sb.players.length) { await emit({ type: "error", message: "Player data for one of these teams is not cached yet. Run the daily fill first." }); return { ok: false }; }
  const ra = teamRating(sa), rb = teamRating(sb), reca = teamRecap(sa), recb = teamRecap(sb);
  await emit({ type: "teams", a: { team: sa.team, rating: ra, recap: reca }, b: { team: sb.team, rating: rb, recap: recb } });
  // Stream the 10,000-game Monte Carlo over ~5s so the user watches the odds converge.
  // The SIMULATION ratings are the same Elo + squad-quality nudge the whole-tournament model
  // uses (one source of truth for win probabilities); raw squad ratings compress the gap
  // between giants and minnows and would contradict the tournament table. The squad data
  // still drives everything narrative: key players, recaps, and the pundit's material.
  const sra = strengthFor(teamA, ra.mean_rating), srb = strengthFor(teamB, rb.mean_rating);
  await emit({ type: "status", text: `Simulating ${sa.team} vs ${sb.team}, 10,000 games...` });
  await emit({ type: "sim_start", team_a: sa.team, team_b: sb.team });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const sim = await simulateMatchStream({ attack: sra.attack, defense: sra.defense }, { attack: srb.attack, defense: srb.defense }, 1.25, async (p) => { await emit({ type: "sim_progress", team_a: sa.team, team_b: sb.team, ...p }); await sleep(380); }, 10000, 12);
  const simPayload = { team_a: sa.team, team_b: sb.team, ...sim };
  await emit({ type: "simulation", ...simPayload });
  await emit({ type: "status", text: "The AI is studying both squads and the simulation..." });

  const prof = (t, r, rec) => `${t}: model strength attack ${r.attack}, defense ${r.defense} (1.0 = average), squad avg rating ${r.mean_rating}. Top attackers: ${rec.top_attack.map((p) => `${p.name} (${p.value})`).join(", ") || "n/a"}. Top defenders: ${rec.top_defense.map((p) => `${p.name} (${p.value})`).join(", ") || "n/a"}.`;
  const user = `Preview this match: ${sa.team} vs ${sb.team}.\n${prof(sa.team, ra, reca)}\n${prof(sb.team, rb, recb)}\nMonte Carlo (10,000 games): ${sa.team} win ${Math.round(sim.win_prob_a * 100)}%, draw ${Math.round(sim.draw_prob * 100)}%, ${sb.team} win ${Math.round(sim.win_prob_b * 100)}%. Expected goals ${sim.expected_goals_a} - ${sim.expected_goals_b}. Most likely scoreline ${sim.likely_scorelines[0]?.score}.`;

  const tools = TOOLS.filter((t) => t.name === "make_prediction");
  const history = [{ role: "system", content: tone === "fun" ? FUN_NATIONS_SYSTEM : NATIONS_SYSTEM }, { role: "user", content: user }];
  const kvCache = `nations-${Date.now()}-${++_seq}`;
  let prediction = null, analysis = "";
  // Step 1: the readable preview. Give a no-op tool (dynamic mode needs non-empty tools)
  // so the model CANNOT jump to make_prediction and must write the preview as content.
  const noopTool = [{ name: "noop", description: "Do not call this. Internal placeholder only.", parameters: z.object({}) }];
  const r1 = await turn({ modelId, history, kvCache, onEvent, tools: noopTool });
  if (r1.content && r1.content.trim()) analysis = r1.content.trim();
  history.push({ role: "assistant", content: r1.content });
  // Step 2: the structured pick.
  if (!prediction) {
    history.push({ role: "user", content: "Now call make_prediction exactly once: your winner, a realistic scoreline (the winner scores more), confidence (low/medium/high), and 2-4 short key_factors." });
    const r2 = await turn({ modelId, history, kvCache, onEvent, tools });
    const tc2 = (r2.toolCalls || []).find((c) => c.name === "make_prediction");
    if (tc2) prediction = buildPrediction(tc2.arguments || {}, sa.team, sb.team);
    if (!analysis && r2.content && r2.content.trim()) analysis = r2.content.trim();
  }
  if (!prediction) {
    const winner = sim.win_prob_a >= sim.draw_prob && sim.win_prob_a >= sim.win_prob_b ? sa.team : sim.win_prob_b >= sim.draw_prob ? sb.team : "Draw";
    const top = sim.likely_scorelines[0]?.score?.split("-").map(Number) || [1, 1];
    const [scA, scB] = attributeScore(winner, sa.team, sb.team, top[0] || 0, top[1] || 0);
    prediction = { winner, score_a: scA, score_b: scB, confidence: "medium", key_factors: ["Synthesized from the simulation."] };
  }
  await emit({ type: "verdict", prediction, analysis, simulation: simPayload });
  return { ok: true };
}

// Rewrite the tournament fun facts with personality, fully on-device. One-shot completion
// (kvCache off: a named cache would leak state across calls). Every number in each output
// line is validated against ITS source fact; if the small model invents or mangles one,
// the caller falls back to the plain computed facts.
export async function funFactsRewrite({ modelId, facts }) {
  const sys = `You punch up football tournament facts for a broadcast graphics card. Rewrite each fact as one fun, confident, slightly cheeky line.
Hard rules:
- Keep EVERY number and every team name EXACTLY as given. Same order, one line per fact, no new facts, no hashtags, no emoji.
- Do NOT invent relationships, rivalries, history, nicknames or anything that is not already in the fact.
- Do NOT change what a fact claims. Only the tone changes: "won at least once" must still mean won at least once.
- Every line must end differently. Never reuse a punchline or closing phrase, and do not copy the example's wording.
Answer with ONLY a JSON array of strings.
Example input: ["Spain won 510 of 5,000 simulations."]
Example answer: ["Spain lifted the trophy in 510 of 5,000 universes. Somebody warm up the bus."]`;
  const history = [{ role: "system", content: sys }, { role: "user", content: JSON.stringify(facts) }];
  const noopTool = [{ name: "noop", description: "Do not call this. Internal placeholder only.", parameters: z.object({}) }];
  const r = await turn({ modelId, history, kvCache: false, onEvent: null, tools: noopTool });
  const m = (r.content || "").match(/\[[\s\S]*\]/);
  if (!m) return null;
  let arr; try { arr = JSON.parse(m[0]); } catch { return null; }
  if (!Array.isArray(arr) || arr.length !== facts.length || !arr.every((s) => typeof s === "string" && s.trim())) return null;
  const nums = (s) => (String(s).match(/\d[\d,.]*/g) || []).map((x) => x.replace(/[.,]+$/, ""));
  for (let i = 0; i < arr.length; i++) { const src = new Set(nums(facts[i])); if (!nums(arr[i]).every((n) => src.has(n))) return null; }
  return arr.map((s) => s.replace(/[—–]/g, ", ").trim());
}

// Run the full prediction loop for one fixture. `onEvent` may be async (server paces/streams).
export async function predict({ modelId, teamA, teamB, onEvent }) {
  await refresh();
  const emit = (e) => onEvent?.(e);
  let lastSim = null, prediction = null;

  const execute = async (name, args = {}) => {
    switch (name) {
      case "list_upcoming_matches":
        return JSON.stringify(getFixtures().filter((m) => !m.score && !isPlaceholderTeam(m.team_a) && !isPlaceholderTeam(m.team_b)).slice(0, 12).map((m) => ({ date: m.date, group: m.group, match: `${m.team_a} vs ${m.team_b}` })));
      case "get_team_profile": {
        const r = ratingFor(args.team);
        return JSON.stringify({ team: args.team, attack_strength: r.attack, defense_strength: r.defense, tournament_games: r.games, goals_for: r.gf, goals_against: r.ga, note: r.games < 3 ? "Little tournament history; rating is a neutral prior." : "Rating from recent tournament goals." });
      }
      case "get_head_to_head": {
        const h = headToHead(args.team_a, args.team_b);
        return JSON.stringify({ meetings: h.length, results: h.slice(0, 6) });
      }
      case "simulate_match": {
        // Stream the 10,000-game Monte Carlo over ~5s so the odds visibly converge.
        await emit({ type: "sim_start", team_a: args.team_a, team_b: args.team_b });
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const sim = await simulateMatchStream(ratingFor(args.team_a), ratingFor(args.team_b), getLeagueAvg(), async (p) => { await emit({ type: "sim_progress", team_a: args.team_a, team_b: args.team_b, ...p }); await sleep(380); }, 10000, 12);
        lastSim = { team_a: args.team_a, team_b: args.team_b, ...sim };
        await emit({ type: "simulation", ...lastSim });
        return JSON.stringify({ win_prob_a: sim.win_prob_a, draw_prob: sim.draw_prob, win_prob_b: sim.win_prob_b, expected_goals_a: sim.expected_goals_a, expected_goals_b: sim.expected_goals_b, likely_scorelines: sim.likely_scorelines.slice(0, 4) });
      }
      case "make_prediction":
        prediction = buildPrediction(args, teamA, teamB);
        return "Prediction recorded.";
      default:
        return `Unknown tool: ${name}`;
    }
  };

  const history = [
    { role: "system", content: SYSTEM },
    { role: "user", content: `Predict the tournament match: ${teamA} (first team) vs ${teamB} (second team).` },
  ];
  // Unique kvCache per prediction, reused across this run's hops (a fixed cache reused
  // across separate predictions would poison dynamic-tools state; per-hop unique caches
  // would re-encode the whole growing history every hop). Matches QVAC CORE.
  const kvCache = `predict-${Date.now()}-${++_seq}`;
  let nudged = false;

  for (let hop = 0; hop < MAX_TOOL_HOPS; hop++) {
    const { content, toolCalls } = await turn({ modelId, history, kvCache, onEvent });
    history.push({ role: "assistant", content });
    if (!toolCalls.length) {
      // The model answered in prose. If it has the simulation but never finalized,
      // nudge it once to record the prediction via the tool; otherwise stop.
      if (!prediction && lastSim && !nudged) {
        nudged = true;
        history.push({ role: "user", content: "Good. Now call make_prediction EXACTLY ONCE: winner, a realistic scoreline (score_a = first team, score_b = second team), confidence, and 3-5 short key_factors." });
        continue;
      }
      break;
    }
    for (const call of toolCalls) {
      const result = await execute(call.name, call.arguments || {});
      await emit({ type: "tool_result", name: call.name, tag: TOOL_TAGS[call.name] || "local" });
      history.push({ role: "tool", content: result });
    }
    if (prediction) break;
  }

  // Fallback: if the model never called make_prediction, synthesize from the simulation.
  if (!prediction && lastSim) {
    const { win_prob_a: a, draw_prob: d, win_prob_b: b } = lastSim;
    const winner = a >= d && a >= b ? teamA : b >= d && b >= a ? teamB : "Draw";
    const top = lastSim.likely_scorelines[0]?.score?.split("-").map(Number) || [1, 1];
    const [sa, sb] = attributeScore(winner, teamA, teamB, top[0] || 0, top[1] || 0);
    prediction = { winner, score_a: sa, score_b: sb, confidence: Math.max(a, d, b) > 0.5 ? "medium" : "low", key_factors: ["Synthesized from the simulation (the model did not finalize)."] };
  }

  await emit({ type: "verdict", prediction, simulation: lastSim });
  return { prediction, simulation: lastSim };
}

// Convenience loader matching the recipe's defaults.
export async function loadPredictor(modelKey = "big") {
  return loadModel({
    modelSrc: LLM[modelKey], modelType: "llm",
    modelConfig: { ctx_size: 8192, tools: true, toolsMode: "dynamic", reasoning_budget: -1, temp: 0.6 },
  });
}
export { unloadModel };
