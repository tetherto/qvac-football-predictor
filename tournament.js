// Whole-tournament model. Derives the group draw + knockout bracket from the openfootball
// 2026 schedule, then Monte-Carlos the entire tournament: group round-robins -> standings ->
// qualifiers (top 2 of each group + the 8 best third-placed teams) -> the knockout bracket
// (resolving 1A / 2B / 3A-B-C-D-F / W73 / L101 placeholders) -> a champion. Aggregated over
// thousands of runs, this gives each nation's chance of reaching each round.
//
// Ratings blend player-derived strength (cached nations) with tournament history (everyone
// else). One sampled match = simulate.js sampleScore (cheap; a run plays 104 matches).

import { refresh, getFixtures } from "./data.js";
import { sampleScore } from "./simulate.js";
import { squadScored, teamRating } from "./data-apifootball.js";
import { readManifest } from "./apifootball.js";
import { strengthFor } from "./strength.js";

const KO_ROUNDS = ["Round of 32", "Round of 16", "Quarter-final", "Semi-final", "Match for third place", "Final"];
const STAGE_IDX = { "Round of 32": 1, "Round of 16": 2, "Quarter-final": 3, "Semi-final": 4, "Final": 5 };
const NEUTRAL = { attack: 1, defense: 1 };

// Group draw: { "A": [t1..t4], ... } from the group-stage fixtures.
export function getGroups() {
  const g = {};
  for (const m of getFixtures()) {
    if (!m.group) continue;
    const letter = m.group.replace("Group ", "");
    (g[letter] ??= new Set()).add(m.team_a); g[letter].add(m.team_b);
  }
  const out = {};
  for (const k of Object.keys(g).sort()) out[k] = [...g[k]];
  return out;
}

// Knockout matches, numbered 73.. in fixture order, with their slot placeholders.
export function getKnockout() {
  return getFixtures().filter((m) => KO_ROUNDS.includes(m.round))
    .map((m, i) => ({ num: 73 + i, round: m.round, date: m.date, a: m.team_a, b: m.team_b, score: m.score }));
}

// Full schedule (group + knockout) with a stable id per match (M73.. for knockout).
export function getSchedule() {
  let ko = 73;
  return getFixtures().map((m, i) => {
    const isKo = KO_ROUNDS.includes(m.round);
    return { id: isKo ? `M${ko++}` : `G${i}`, round: m.round, group: m.group || null, date: m.date, time: m.time, team_a: m.team_a, team_b: m.team_b, score: m.score, knockout: isKo };
  });
}

// Blend a strength rating for every tournament team: player-derived where we have a squad,
// tournament history otherwise, a neutral prior for debutants.
export async function buildRatings() {
  const teams = Object.values(getGroups()).flat();
  const cached = new Set(Object.keys(readManifest()));
  const ratings = {};
  for (const t of teams) {
    if (cached.has(t)) {
      const r = teamRating(await squadScored(t, { allowFetch: false }));
      const s = strengthFor(t, r.mean_rating);
      ratings[t] = { attack: s.attack, defense: s.defense, elo: s.elo, source: "players+elo", mean_rating: r.mean_rating };
    } else {
      const s = strengthFor(t);
      ratings[t] = { attack: s.attack, defense: s.defense, elo: s.elo, source: s.known ? "elo" : "prior" };
    }
  }
  return ratings;
}

const order3 = (a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || (Math.random() - 0.5);

// One group stage -> { A: [sorted rows], ... }.
function simGroups(groups, R, avg) {
  const standings = {};
  for (const [letter, teams] of Object.entries(groups)) {
    const row = {}; for (const t of teams) row[t] = { team: t, pts: 0, gf: 0, ga: 0, gd: 0 };
    for (let i = 0; i < teams.length; i++) for (let j = i + 1; j < teams.length; j++) {
      const A = teams[i], B = teams[j];
      const [ga, gb] = sampleScore(R[A] || NEUTRAL, R[B] || NEUTRAL, avg);
      row[A].gf += ga; row[A].ga += gb; row[B].gf += gb; row[B].ga += ga;
      if (ga > gb) row[A].pts += 3; else if (gb > ga) row[B].pts += 3; else { row[A].pts++; row[B].pts++; }
    }
    for (const t of teams) row[t].gd = row[t].gf - row[t].ga;
    standings[letter] = Object.values(row).sort(order3);
  }
  return standings;
}

// The 8 best third-placed teams, keyed by group, for the bracket's "3A/B/..." slots.
function thirdsMap(standings) {
  const thirds = Object.entries(standings).map(([letter, rows]) => ({ ...rows[2], group: letter }));
  thirds.sort(order3);
  const top8 = thirds.slice(0, 8);
  const byGroup = {}; for (const t of top8) byGroup[t.group] = t.team;
  return byGroup;
}

function slotTeam(slot, standings, thirdsByGroup) {
  if (/^[12][A-L]$/.test(slot)) { return standings[slot[1]]?.[+slot[0] - 1]?.team; }   // 1A / 2B
  if (slot[0] === "3") { for (const L of slot.slice(1).split("/")) if (thirdsByGroup[L]) { const t = thirdsByGroup[L]; delete thirdsByGroup[L]; return t; } return null; }
  return null;
}

// Knockout result. On a draw, decide by a strength-weighted coin (shootout proxy).
function koPlay(A, B, R, avg) {
  if (!A || !B) return { w: A || B, l: A ? null : B, score: null, pens: false };
  const [ga, gb] = sampleScore(R[A] || NEUTRAL, R[B] || NEUTRAL, avg);
  if (ga === gb) { const pa = (R[A]?.attack || 1) / ((R[A]?.attack || 1) + (R[B]?.attack || 1)); const w = Math.random() < pa ? A : B; return { w, l: w === A ? B : A, score: [ga, gb], pens: true }; }
  const w = ga > gb ? A : B; return { w, l: w === A ? B : A, score: [ga, gb], pens: false };
}

// One full tournament. detail=true returns the resolved bracket + standings for display.
function runOnce(groups, knockout, R, avg, detail) {
  const standings = simGroups(groups, R, avg);
  const thirdsByGroup = thirdsMap(standings);
  const W = {}, L = {}, reached = {}, matches = detail ? [] : null;
  let finalists = null;
  const resolve = (slot) => slot[0] === "W" ? W[+slot.slice(1)] : slot[0] === "L" ? L[+slot.slice(1)] : slotTeam(slot, standings, thirdsByGroup);
  for (const m of knockout) {
    const isThird = m.round === "Match for third place";
    const A = resolve(m.a), B = resolve(m.b);
    if (!isThird) { const s = STAGE_IDX[m.round]; for (const t of [A, B]) if (t) reached[t] = Math.max(reached[t] || 0, s); }
    const res = koPlay(A, B, R, avg);
    W[m.num] = res.w; L[m.num] = res.l;
    if (m.round === "Final") { if (A && B) finalists = [A, B]; if (res.w) reached[res.w] = 6; }
    if (detail) matches.push({ num: m.num, round: m.round, a: A || m.a, b: B || m.b, score: res.score, winner: res.w, pens: res.pens });
  }
  const champion = W[104] || null;
  if (!detail) return { champion, reached, finalists };
  const standingsOut = {}; for (const [k, rows] of Object.entries(standings)) standingsOut[k] = rows.map((r) => ({ team: r.team, pts: r.pts, gd: r.gd, gf: r.gf }));
  return { champion, reached, standings: standingsOut, matches };
}

// The model's single most-likely bracket ("chalk"): stronger team advances, scoreline ~
// expected goals. Shown as the predicted bracket; the probabilities capture the upside/upset.
function expectedBracket(groups, knockout, R, avg) {
  const standings = {};
  for (const [letter, teams] of Object.entries(groups)) standings[letter] = teams.map((t) => ({ team: t, elo: R[t]?.elo || 1820 })).sort((a, b) => b.elo - a.elo);
  const thirdsByGroup = {};
  Object.entries(standings).map(([letter, rows]) => ({ team: rows[2].team, elo: rows[2].elo, group: letter })).sort((a, b) => b.elo - a.elo).slice(0, 8).forEach((t) => { thirdsByGroup[t.group] = t.team; });
  const W = {}, L = {}, matches = [];
  const slot = (s) => { if (/^[12][A-L]$/.test(s)) return standings[s[1]]?.[+s[0] - 1]?.team; if (s[0] === "3") { for (const x of s.slice(1).split("/")) if (thirdsByGroup[x]) { const t = thirdsByGroup[x]; delete thirdsByGroup[x]; return t; } return null; } return null; };
  const resolve = (s) => s[0] === "W" ? W[+s.slice(1)] : s[0] === "L" ? L[+s.slice(1)] : slot(s);
  for (const m of knockout) {
    const A = resolve(m.a), B = resolve(m.b);
    let w = A || B, score = null;
    if (A && B) {
      const la = avg * (R[A]?.attack || 1) * (R[B]?.defense || 1), lb = avg * (R[B]?.attack || 1) * (R[A]?.defense || 1);
      let sa = Math.round(la), sb = Math.round(lb);
      if (sa === sb) { if ((R[A]?.elo || 0) >= (R[B]?.elo || 0)) sa++; else sb++; }
      w = sa > sb ? A : B; score = [sa, sb];
    }
    W[m.num] = w; L[m.num] = w === A ? B : A;
    matches.push({ num: m.num, round: m.round, a: A || m.a, b: B || m.b, score, winner: w });
  }
  const standingsOut = {}; for (const [k, rows] of Object.entries(standings)) standingsOut[k] = rows.map((r) => ({ team: r.team, elo: r.elo }));
  return { standings: standingsOut, matches, champion: W[104] };
}

// The single PREDICTED tournament, match by match (group round-robins + knockout), each with
// the favourite + win-probability. Deterministic: the stronger team always advances, so this
// "most likely" run is CONSISTENT with the aggregate odds (its champion = the predicted
// champion). The wild upset runs are surfaced separately as fun facts, not as the headline.
function samplePlayByPlay(groups, knockout, R, avg, forceWinner) {
  const elo = (t) => R[t]?.elo || 1820, att = (t) => R[t]?.attack || 1, def = (t) => R[t]?.defense || 1;
  const winPct = (a, b) => 1 / (1 + Math.pow(10, (elo(b) - elo(a)) / 400));
  const eloOrder = (x, y) => y.pts - x.pts || y.gd - x.gd || y.gf - x.gf || elo(y.team) - elo(x.team);
  // Deterministic: stronger team wins (unless forceWinner is in the tie, so the most-likely
  // champion's actual winning path is shown), with a plausible expected-goals scoreline.
  const decide = (a, b) => { const w = (forceWinner && (a === forceWinner || b === forceWinner)) ? forceWinner : (elo(a) >= elo(b) ? a : b); let sa = Math.round(avg * att(a) * def(b)), sb = Math.round(avg * att(b) * def(a)); if (w === a) { if (sa <= sb) sa = sb + 1; } else if (sb <= sa) sb = sa + 1; return { sa, sb, w }; };
  const mk = (round, a, b, sa, sb, w) => { const fav = elo(a) >= elo(b) ? a : b; return { round, a, b, sa, sb, winner: w, fav, favProb: Math.round(winPct(fav, fav === a ? b : a) * 100), pens: false }; };
  const matches = [], standings = {};
  for (const [letter, teams] of Object.entries(groups)) {
    const row = {}; for (const t of teams) row[t] = { team: t, pts: 0, gf: 0, ga: 0, gd: 0 };
    for (let i = 0; i < teams.length; i++) for (let j = i + 1; j < teams.length; j++) {
      const A = teams[i], B = teams[j], { sa, sb, w } = decide(A, B);
      row[A].gf += sa; row[A].ga += sb; row[B].gf += sb; row[B].ga += sa;
      if (w === A) row[A].pts += 3; else row[B].pts += 3;
      matches.push(mk(`Group ${letter}`, A, B, sa, sb, w));
    }
    for (const t of teams) row[t].gd = row[t].gf - row[t].ga;
    standings[letter] = Object.values(row).sort(eloOrder);
  }
  const thirdsByGroup = {};
  Object.entries(standings).map(([l, rows]) => ({ team: rows[2].team, group: l })).sort((x, y) => elo(y.team) - elo(x.team)).slice(0, 8).forEach((t) => { thirdsByGroup[t.group] = t.team; });
  const W = {}, L = {};
  const resolve = (s) => s[0] === "W" ? W[+s.slice(1)] : s[0] === "L" ? L[+s.slice(1)] : slotTeam(s, standings, thirdsByGroup);
  for (const m of knockout) {
    const A = resolve(m.a), B = resolve(m.b);
    if (!A || !B) { W[m.num] = A || B; L[m.num] = null; continue; }
    const { sa, sb, w } = decide(A, B); W[m.num] = w; L[m.num] = w === A ? B : A;
    matches.push(mk(m.round, A, B, sa, sb, w));
  }
  return { matches, champion: W[104] || null };
}

// Fun facts mined from the aggregate runs: surprise champions, favourite fragility, the
// final the sims keep producing, the dark horse, the toughest group. All numbers come
// straight from the simulation tallies (the on-device LLM only rephrases them).
function computeFunFacts(stat, probs, runs, R, groups, topFinals) {
  const elo = (t) => R[t]?.elo || 1820, pct = (x) => Math.round(x * 100), n = (x) => Math.round(x * runs);
  const facts = [], champs = probs.filter((p) => p.win > 0);
  if (topFinals && topFinals[0]) { const f = topFinals[0]; facts.push(`The final the sims keep booking: ${f.a} v ${f.b}, seen ${f.n} times in ${runs.toLocaleString()} runs.`); }
  if (champs.length) facts.push(`${champs.length} different nations lifted the trophy at least once across ${runs.toLocaleString()} simulations.`);
  const cinderella = [...champs].sort((a, b) => elo(a.team) - elo(b.team))[0];
  if (cinderella && n(cinderella.win) >= 1) facts.push(`Even ${cinderella.team} pulled it off: champions in ${n(cinderella.win)} of ${runs.toLocaleString()} runs. You never know.`);
  const fav = probs[0];
  if (fav) facts.push(`The favourite, ${fav.team}, still crashes out before the final ${pct(1 - fav.final)}% of the time.`);
  const rankByElo = [...probs].sort((a, b) => elo(b.team) - elo(a.team)).map((p) => p.team);
  const darkHorse = probs.filter((p) => rankByElo.indexOf(p.team) >= 12).sort((a, b) => b.sf - a.sf)[0];
  if (darkHorse && darkHorse.sf > 0.02) facts.push(`Dark horse: ${darkHorse.team}, outside the top twelve on paper, still reaches the semi-finals in ${pct(darkHorse.sf)}% of runs.`);
  if (groups) {
    const death = Object.entries(groups).map(([L, ts]) => ({ L, avg: ts.reduce((s, t) => s + elo(t), 0) / ts.length })).sort((a, b) => b.avg - a.avg)[0];
    if (death) facts.push(`Group ${death.L} is the group of death: the strongest four-team average of the twelve groups.`);
  }
  return facts.slice(0, 6);
}

function blankStat(groups, R) {
  const stat = {}; for (const t of Object.values(groups).flat()) stat[t] = { team: t, source: R[t]?.source, elo: R[t]?.elo, r16: 0, qf: 0, sf: 0, final: 0, win: 0 };
  return stat;
}
function tally(stat, reached) {
  for (const [t, st] of Object.entries(reached)) { const s = stat[t]; if (!s) continue; if (st >= 2) s.r16++; if (st >= 3) s.qf++; if (st >= 4) s.sf++; if (st >= 5) s.final++; if (st >= 6) s.win++; }
}
function finalizeProbs(stat, n) {
  return Object.values(stat).map((s) => ({ team: s.team, source: s.source, elo: s.elo, r16: s.r16 / n, qf: s.qf / n, sf: s.sf / n, final: s.final / n, win: s.win / n }))
    .sort((a, b) => b.win - a.win || b.final - a.final || b.sf - a.sf);
}

// Monte-Carlo the whole tournament (one shot). Returns reach probabilities, the predicted
// bracket, the play-by-play run, the most-seen finals, and computed fun facts.
export async function simulateTournament(runs = 3000) {
  await refresh();
  const groups = getGroups(), knockout = getKnockout(), R = await buildRatings(), avg = 1.25;
  const stat = blankStat(groups, R);
  const finalCounts = {}; // "A|B" (sorted) -> { n, wins: { team: count } }
  for (let i = 0; i < runs; i++) {
    const r = runOnce(groups, knockout, R, avg, false);
    tally(stat, r.reached);
    if (r.finalists) {
      const key = [...r.finalists].sort().join("|");
      const fc = finalCounts[key] || (finalCounts[key] = { n: 0, wins: {} });
      fc.n++; if (r.champion) fc.wins[r.champion] = (fc.wins[r.champion] || 0) + 1;
    }
  }
  const probs = finalizeProbs(stat, runs);
  const topFinals = Object.entries(finalCounts).sort((x, y) => y[1].n - x[1].n).slice(0, 6).map(([key, v]) => {
    const [a, b] = key.split("|");
    return { a, b, n: v.n, pct: Math.round((v.n / runs) * 1000) / 10, winsA: v.wins[a] || 0, winsB: v.wins[b] || 0 };
  });
  return { runs, probs, bracket: expectedBracket(groups, knockout, R, avg), playByPlay: samplePlayByPlay(groups, knockout, R, avg, probs[0]?.team), topFinals, funFacts: computeFunFacts(stat, probs, runs, R, groups, topFinals) };
}

// Streamed version: runs in chunks and calls onChunk({done,total,probs,lastChampion}) as the
// estimates converge, so the UI can show the Monte Carlo actually happening (the numbers start
// noisy and settle). onChunk may be async (the server paces + flushes each chunk).
export async function simulateTournamentStream(runs, onChunk, chunkSize = 100, onStart) {
  await refresh();
  const groups = getGroups(), knockout = getKnockout(), R = await buildRatings(), avg = 1.25;
  if (onStart) await onStart({ playByPlay: samplePlayByPlay(groups, knockout, R, avg) });
  const stat = blankStat(groups, R);
  let done = 0;
  for (let c = 0; c < runs; c += chunkSize) {
    const n = Math.min(chunkSize, runs - c);
    let lastChampion = null;
    for (let i = 0; i < n; i++) { const r = runOnce(groups, knockout, R, avg, false); lastChampion = r.champion; tally(stat, r.reached); }
    done += n;
    if (onChunk) await onChunk({ done, total: runs, probs: finalizeProbs(stat, done), lastChampion });
  }
  const probs = finalizeProbs(stat, runs);
  return { runs, probs, bracket: expectedBracket(groups, knockout, R, avg), funFacts: computeFunFacts(stat, probs, runs, R, groups, null) };
}
