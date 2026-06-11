// Fetch and cache the 2026 tournament fixtures + historical results from the keyless,
// public-domain openfootball dataset, and derive a coarse attack/defense rating per
// national team from historical goals. No API key. The LLM never sees a key; the host
// does the fetch and exposes the data through tools.

const RAW = "https://raw.githubusercontent.com/openfootball/worldcup.json/master";
const HISTORY_YEARS = ["2022", "2018", "2014"]; // reference set for strength priors
const TTL_MS = 1000 * 60 * 30; // 30 min

const cache = { fixtures: null, ratings: null, hist: null, leagueAvg: 1.35, fetchedAt: 0 };

// Map historical name variants to the 2026 fixture spelling so ratings attach correctly.
const ALIASES = { "Bosnia-Herzegovina": "Bosnia & Herzegovina", "Côte d'Ivoire": "Ivory Coast" };
const norm = (n) => ALIASES[n] || n;
// Knockout-bracket placeholders in the fixtures ("1A", "2B", "3A/B/C/D/F", "W73", "L101")
// are not real teams: any name containing a digit or slash.
export function isPlaceholderTeam(n) { return /[0-9/]/.test(String(n)); }

// Tolerant accessors: the dataset's nested shape has drifted across years.
const teamName = (t) => (typeof t === "string" ? t : t?.name || t?.code || "Unknown");
function ftScore(m) {
  if (m?.score?.ft && Array.isArray(m.score.ft)) return m.score.ft;            // { score: { ft: [a,b] } }
  if (Number.isInteger(m?.score1) && Number.isInteger(m?.score2)) return [m.score1, m.score2];
  return null; // not played yet
}
function matchesOf(doc) {
  if (Array.isArray(doc?.matches)) return doc.matches;
  if (Array.isArray(doc?.rounds)) return doc.rounds.flatMap((r) => r.matches || []);
  return [];
}
async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url} -> ${r.status}`);
  return r.json();
}

const round2 = (x) => Math.round(x * 100) / 100;

export async function refresh() {
  if (cache.fixtures && Date.now() - cache.fetchedAt < TTL_MS) return;

  const fixturesDoc = await getJson(`${RAW}/2026/worldcup.json`);
  const fixtures = matchesOf(fixturesDoc).map((m) => ({
    round: m.round, date: m.date, time: m.time, group: m.group, ground: teamName(m.ground) === "Unknown" ? m.ground : m.ground,
    team_a: teamName(m.team1), team_b: teamName(m.team2), score: ftScore(m),
  }));

  // History: goals for/against per team across recent tournaments.
  const histDocs = await Promise.all(HISTORY_YEARS.map((y) =>
    getJson(`${RAW}/${y}/worldcup.json`).then((d) => ({ y, ms: matchesOf(d) })).catch(() => ({ y, ms: [] }))
  ));
  const hist = []; // flat list of played matches for head-to-head
  const acc = {};  // team -> { gf, ga, games }
  let totalGoals = 0, totalSides = 0;
  for (const { y, ms } of histDocs) {
    for (const m of ms) {
      const s = ftScore(m); if (!s) continue;
      const A = norm(teamName(m.team1)), B = norm(teamName(m.team2));
      if (A === "Unknown" || B === "Unknown") continue;
      acc[A] ??= { gf: 0, ga: 0, games: 0 }; acc[B] ??= { gf: 0, ga: 0, games: 0 };
      acc[A].gf += s[0]; acc[A].ga += s[1]; acc[A].games++;
      acc[B].gf += s[1]; acc[B].ga += s[0]; acc[B].games++;
      totalGoals += s[0] + s[1]; totalSides += 2;
      hist.push({ year: y, a: A, b: B, score: s });
    }
  }
  const leagueAvg = totalSides ? totalGoals / totalSides : 1.35;

  const ratings = {};
  for (const [team, a] of Object.entries(acc)) {
    // Shrink toward 1.0 for teams with few games so one thrashing does not dominate.
    const k = 4; // pseudo-games of prior at strength 1.0
    const attack = (a.gf + k * leagueAvg) / ((a.games + k) * leagueAvg);
    const defense = (a.ga + k * leagueAvg) / ((a.games + k) * leagueAvg);
    ratings[team] = { attack: round2(attack), defense: round2(defense), games: a.games, gf: a.gf, ga: a.ga };
  }

  cache.fixtures = fixtures;
  cache.ratings = ratings;
  cache.hist = hist;
  cache.leagueAvg = round2(leagueAvg);
  cache.fetchedAt = Date.now();
}

// Debutants / teams absent from the reference set get a neutral rating.
export function ratingFor(team) {
  return cache.ratings?.[team] || { attack: 1.0, defense: 1.0, games: 0, gf: 0, ga: 0 };
}
export function getFixtures() { return cache.fixtures || []; }
export function getLeagueAvg() { return cache.leagueAvg; }
export function headToHead(a, b) {
  return (cache.hist || []).filter((m) => (m.a === a && m.b === b) || (m.a === b && m.b === a))
    .map((m) => ({ year: m.year, result: `${m.a} ${m.score[0]}-${m.score[1]} ${m.b}` }));
}

// Every team across the 2026 fixtures + the rated history, with a simple "power"
// (attack / defense; higher attack and lower goals-conceded = stronger), sorted strong
// to weak. Teams with no recent tournament history carry a neutral 1.0/1.0 prior.
export function allTeams() {
  const set = new Set();
  for (const m of cache.fixtures || []) { set.add(m.team_a); set.add(m.team_b); }
  for (const t of Object.keys(cache.ratings || {})) set.add(t);
  set.delete("Unknown");
  return [...set]
    .filter((team) => !isPlaceholderTeam(team))
    .map((team) => {
      const r = ratingFor(team);
      return { team, attack: r.attack, defense: r.defense, games: r.games, gf: r.gf, ga: r.ga, power: Math.round((r.attack / r.defense) * 100) / 100, has_history: r.games > 0 };
    })
    .sort((a, b) => b.power - a.power);
}
