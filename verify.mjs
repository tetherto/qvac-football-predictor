// Headless end-to-end verification of the predictor against the live @qvac/sdk,
// exercising the SAME engine.js the server uses. Proves:
//  (1) the model orchestrates the tools (profiles -> h2h -> simulate),
//  (2) reasoning is visible (thinkingDelta events stream),
//  (3) the Monte Carlo simulation runs and its probabilities reach the result,
//  (4) a final prediction is produced (model-made or synthesized fallback).
// Run: node verify.mjs
import { loadPredictor, unloadModel } from "./engine.js";
import { predict } from "./engine.js";

let pass = 0, fail = 0;
const tally = (c, m) => { if (c) { pass++; console.log(`  PASS ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };

console.log("[load] Qwen3 4B (dynamic tools + thinking)...");
const modelId = await loadPredictor("big");
console.log("loaded\n");

async function run(teamA, teamB) {
  console.log(`== Predict: ${teamA} vs ${teamB} ==`);
  let thinkingChars = 0, contentChars = 0, madePrediction = false;
  const toolCalls = [];
  let sim = null, verdict = null;
  await predict({
    modelId, teamA, teamB,
    onEvent: (e) => {
      if (e.type === "thinking") thinkingChars += e.text.length;
      else if (e.type === "content") contentChars += e.text.length;
      else if (e.type === "tool_call") { toolCalls.push(e.name); if (e.name === "make_prediction") madePrediction = true; console.log(`  -> tool: ${e.name}(${JSON.stringify(e.args)}) [${e.tag}]`); }
      else if (e.type === "simulation") sim = e;
      else if (e.type === "verdict") verdict = e;
    },
  });
  console.log(`  thinking chars: ${thinkingChars} | content chars: ${contentChars}`);
  if (sim) console.log(`  SIM ${sim.team_a} ${(sim.win_prob_a*100).toFixed(0)}% / draw ${(sim.draw_prob*100).toFixed(0)}% / ${sim.team_b} ${(sim.win_prob_b*100).toFixed(0)}%  xG ${sim.expected_goals_a}-${sim.expected_goals_b}`);
  console.log(`  PREDICTION:`, JSON.stringify(verdict?.prediction));

  tally(toolCalls.includes("get_team_profile"), `called get_team_profile (tools: ${[...new Set(toolCalls)].join(", ")})`);
  tally(toolCalls.includes("simulate_match"), `ran the Monte Carlo simulation`);
  tally(thinkingChars > 0, `reasoning was visible (${thinkingChars} thinking chars streamed)`);
  tally(!!verdict?.prediction && typeof verdict.prediction.winner === "string", `produced a prediction (make_prediction called: ${madePrediction})`);
  tally(!!verdict?.simulation && verdict.simulation.win_prob_a + verdict.simulation.draw_prob + verdict.simulation.win_prob_b > 0.99, `result carries grounded simulation probabilities`);
  const p = verdict?.prediction || {};
  const consistent = p.winner === "Draw" ? p.score_a === p.score_b
    : p.winner === teamA ? p.score_a > p.score_b
    : p.winner === teamB ? p.score_b > p.score_a : true;
  tally(consistent, `winner agrees with scoreline (${p.winner}: ${p.score_a}-${p.score_b})`);
  console.log("");
}

await run("Brazil", "Morocco");   // lopsided
await run("Brazil", "Argentina"); // close (previously gave a winner/scoreline contradiction)

await unloadModel({ modelId, clearStorage: false });
console.log(`==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
