// Incremental fill: cache squads + per-player season stats for target teams, up to the
// day's remaining budget (it auto-defers when the budget floor is hit). Re-runs fill
// more (cached players are skipped).
//   node --env-file=.env.local prefetch.js                # marquee contenders
//   node --env-file=.env.local prefetch.js --all          # all 48, ordered by first fixture
//   node --env-file=.env.local prefetch.js France Japan   # explicit list
// Starts with a /status probe so a plan upgrade (stale-low on-disk budget) is picked up.
import "./env.js"; // loads .env.local first: data-apifootball reads AF_SEASON at import time
import { squadScored, teamRating, SEASON } from "./data-apifootball.js";
import { budget, afStatus } from "./apifootball.js";

const status = await afStatus();
console.log(`Plan: ${status.plan} | day limit ${status.limitDay} | used ${status.used} | remaining ${status.remaining} | season ${SEASON}\n`);

// Marquee tournament contenders first (fill these before the long tail).
const DEFAULT = ["Brazil", "Argentina", "France", "England", "Spain", "Germany", "Portugal", "Netherlands", "Belgium", "Italy", "Croatia", "Uruguay", "USA", "Mexico", "Morocco", "Japan"];

async function allByFirstFixture() {
  const d = await import("./data.js");
  await d.refresh();
  const t = await import("./tournament.js");
  const sched = t.getSchedule();
  const first = {};
  for (const m of sched) for (const team of [m.team_a, m.team_b]) {
    if (/[0-9/]/.test(team)) continue; // knockout placeholders
    if (!(team in first) || m.date < first[team]) first[team] = m.date;
  }
  return Object.entries(first).sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0])).map(([team]) => team);
}

const args = process.argv.slice(2);
const teams = args.includes("--all") ? await allByFirstFixture() : args.length ? args : DEFAULT;
console.log(`Filling ${teams.length} nations (in order): ${teams.join(", ")}\n`);

let stop = false;
for (const t of teams) {
  if (stop) { console.log(`${t.padEnd(14)} skipped (budget floor reached)`); continue; }
  try {
    const r = await squadScored(t, { allowFetch: true });
    if (!r.found) { console.log(`${t.padEnd(14)} NOT FOUND`); continue; }
    const rt = teamRating(r);
    console.log(`${r.team.padEnd(14)} cached ${String(r.cachedCount).padStart(2)}/${r.rosterSize}  missing ${String(r.missing.length).padStart(2)}  | rating atk ${rt.attack} def ${rt.defense} (rating ${rt.mean_rating}) complete=${rt.complete}  | budget left ${r.remaining}`);
    if (r.remaining != null && r.remaining <= (Number(process.env.AF_SAFE_MARGIN) || 3) + 2) stop = true;
  } catch (e) { console.log(`${t.padEnd(14)} ERROR: ${e.message}`); }
}
console.log(`\nDone. Budget remaining: ${JSON.stringify(budget())}`);
console.log("Re-run (today if budget remains, else tomorrow) to fill the rest. Cached players are skipped.");
