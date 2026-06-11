// Independent-Poisson goals model. No SDK, no network: pure maths on the host.
// Expected goals for each side come from attack/defense strengths (see data.js).
// This is a toy model, not a sportsbook: the value is a grounded, explainable
// distribution the LLM can read and reason over instead of inventing numbers.

export function poissonSample(lambda) {
  // Knuth's algorithm. lambda is small (~0.5-3 goals) so this is cheap.
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= Math.random(); } while (p > L);
  return k - 1;
}

// One sampled scoreline between two sides. Used by the full-tournament simulator,
// which plays ~104 matches per run and cannot afford simulateMatch's 10k inner loop.
export function sampleScore(ratingA, ratingB, leagueAvgGoals = 1.35) {
  const la = Math.max(0.05, leagueAvgGoals * ratingA.attack * ratingB.defense);
  const lb = Math.max(0.05, leagueAvgGoals * ratingB.attack * ratingA.defense);
  return [poissonSample(la), poissonSample(lb)];
}

// Streamed single-match simulation: plays `runs` games in `chunks` batches and calls
// onChunk({done,total,win_prob_a,draw_prob,win_prob_b,expected_goals_a/b,margin}) after each,
// so the UI can show the win/draw/loss + distribution converging instead of popping in.
// onChunk may be async (the caller paces it). Returns the full result (with heatmap).
export async function simulateMatchStream(ratingA, ratingB, leagueAvgGoals, onChunk, runs = 10000, chunks = 12) {
  const lambdaA = Math.max(0.05, leagueAvgGoals * ratingA.attack * ratingB.defense);
  const lambdaB = Math.max(0.05, leagueAvgGoals * ratingB.attack * ratingA.defense);
  let winA = 0, draw = 0, winB = 0, egA = 0, egB = 0, done = 0;
  const scoreCounts = {}, margin = { a3: 0, a2: 0, a1: 0, d: 0, b1: 0, b2: 0, b3: 0 };
  const per = Math.ceil(runs / chunks);
  const r3 = (x) => Math.round(x * 1000) / 1000;
  const mgNorm = () => { const o = {}; for (const k of Object.keys(margin)) o[k] = r3(margin[k] / done); return o; };
  for (let c = 0; c < chunks; c++) {
    const n = Math.min(per, runs - done);
    for (let i = 0; i < n; i++) {
      const a = poissonSample(lambdaA), b = poissonSample(lambdaB); egA += a; egB += b;
      if (a > b) winA++; else if (a < b) winB++; else draw++;
      const diff = a - b;
      margin[diff >= 3 ? "a3" : diff === 2 ? "a2" : diff === 1 ? "a1" : diff === 0 ? "d" : diff === -1 ? "b1" : diff === -2 ? "b2" : "b3"]++;
      scoreCounts[`${Math.min(a, 5)}-${Math.min(b, 5)}`] = (scoreCounts[`${Math.min(a, 5)}-${Math.min(b, 5)}`] || 0) + 1;
    }
    done += n;
    if (onChunk) await onChunk({ done, total: runs, win_prob_a: r3(winA / done), draw_prob: r3(draw / done), win_prob_b: r3(winB / done), expected_goals_a: Math.round(egA / done * 100) / 100, expected_goals_b: Math.round(egB / done * 100) / 100, margin: mgNorm() });
    if (done >= runs) break;
  }
  const likely = Object.entries(scoreCounts).map(([k, c]) => ({ score: k, prob: r3(c / done) })).sort((x, y) => y.prob - x.prob).slice(0, 6);
  return {
    runs: done, expected_goals_a: Math.round(egA / done * 100) / 100, expected_goals_b: Math.round(egB / done * 100) / 100,
    win_prob_a: r3(winA / done), draw_prob: r3(draw / done), win_prob_b: r3(winB / done), margin: mgNorm(), likely_scorelines: likely,
    heatmap: Array.from({ length: 6 }, (_, a) => Array.from({ length: 6 }, (_, b) => r3((scoreCounts[`${a}-${b}`] || 0) / done))),
  };
}

// ratingA / ratingB: { attack, defense } multipliers around 1.0 (see data.js).
// leagueAvgGoals: average goals scored by ONE side in the reference dataset (~1.35).
export function simulateMatch(ratingA, ratingB, leagueAvgGoals = 1.35, runs = 10000) {
  const lambdaA = Math.max(0.05, leagueAvgGoals * ratingA.attack * ratingB.defense);
  const lambdaB = Math.max(0.05, leagueAvgGoals * ratingB.attack * ratingA.defense);

  let winA = 0, draw = 0, winB = 0;
  const scoreCounts = {}; // "a-b" -> count, capped at 5 each for the heatmap
  // Goal-margin distribution: a far more legible headline than the heatmap.
  const margin = { a3: 0, a2: 0, a1: 0, d: 0, b1: 0, b2: 0, b3: 0 };

  for (let i = 0; i < runs; i++) {
    const a = poissonSample(lambdaA);
    const b = poissonSample(lambdaB);
    if (a > b) winA++; else if (a < b) winB++; else draw++;
    const diff = a - b;
    margin[diff >= 3 ? "a3" : diff === 2 ? "a2" : diff === 1 ? "a1" : diff === 0 ? "d" : diff === -1 ? "b1" : diff === -2 ? "b2" : "b3"]++;
    const key = `${Math.min(a, 5)}-${Math.min(b, 5)}`;
    scoreCounts[key] = (scoreCounts[key] || 0) + 1;
  }
  for (const k of Object.keys(margin)) margin[k] = Math.round((margin[k] / runs) * 1000) / 1000;

  const likely = Object.entries(scoreCounts)
    .map(([k, c]) => ({ score: k, prob: Math.round((c / runs) * 1000) / 1000 }))
    .sort((x, y) => y.prob - x.prob)
    .slice(0, 6);

  return {
    runs,
    expected_goals_a: Math.round(lambdaA * 100) / 100,
    expected_goals_b: Math.round(lambdaB * 100) / 100,
    win_prob_a: Math.round((winA / runs) * 1000) / 1000,
    draw_prob: Math.round((draw / runs) * 1000) / 1000,
    win_prob_b: Math.round((winB / runs) * 1000) / 1000,
    margin, // { a3,a2,a1,d,b1,b2,b3 } goal-difference distribution (probabilities)
    likely_scorelines: likely,
    // 6x6 grid (rows = team A goals 0..5, cols = team B goals 0..5) for a heatmap.
    heatmap: Array.from({ length: 6 }, (_, a) =>
      Array.from({ length: 6 }, (_, b) => Math.round(((scoreCounts[`${a}-${b}`] || 0) / runs) * 1000) / 1000)
    ),
  };
}
