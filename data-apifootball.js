// National-team Moneyball adapter on API-Football. Current squads + per-player club-season
// form for the season set by AF_SEASON (the free plan only covers older seasons; paid plans
// reach the current one). Scores are ABSOLUTE-scaled (vs sensible per-90 caps) rather than
// percentiled, so they are stable even when only a few teams are cached. The API's own
// match `rating` (0-10) is the backbone quality signal. Same {attack,defense,technique,
// endurance,injury_risk,overall} 0-100 + team rating interface as the club-data adapter,
// so the simulator/UI is source-agnostic.
import { afGet, afCached, budget, updateManifest, readManifest } from "./apifootball.js";
export { readManifest };

export const SEASON = Number(process.env.AF_SEASON) || 2023; // override via AF_SEASON (.env.local)
const POSMAP = { Goalkeeper: "GK", Defender: "DEF", Midfielder: "MID", Attacker: "FWD" };
const num = (x) => (x == null || x === "" ? 0 : Number(x)) || 0;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const scale = (v, cap) => clamp((v / cap) * 100, 0, 100);
const ratingScore = (r) => clamp(((r - 6.0) / 2.0) * 100, 0, 100); // 6.0->0, 8.0->100

const TTL = { teams: 1e12, squad: 1000 * 60 * 60 * 24 * 7, player: 1000 * 60 * 60 * 24 * 5 };

// The /teams search field only accepts alphanumerics + spaces, and a few API team
// names differ from the tournament schedule's names. Sanitize + alias before searching.
const SEARCH_ALIAS = { "Bosnia & Herzegovina": "Bosnia", "Curaçao": "Curacao", "DR Congo": "Congo DR" };
const sanitizeSearch = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-zA-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
export async function nationalTeamId(name, opts = {}) {
  const q = sanitizeSearch(SEARCH_ALIAS[name] || name);
  const r = await afGet("/teams", { search: q }, { ttlMs: TTL.teams, ...opts });
  const nats = (r.data || []).filter((t) => t.team.national);
  const want = (SEARCH_ALIAS[name] || name).toLowerCase();
  const nat = nats.find((t) => t.team.name.toLowerCase() === want) || nats[0] || (r.data || [])[0];
  return nat ? { id: nat.team.id, name: nat.team.name } : null;
}
export async function getSquad(teamId, opts = {}) {
  const r = await afGet("/players/squads", { team: teamId }, { ttlMs: TTL.squad, ...opts });
  return r.data?.[0]?.players || [];
}
export async function getPlayer(playerId, opts = {}) {
  const r = await afGet("/players", { id: playerId, season: SEASON }, { ttlMs: TTL.player, ...opts });
  return { data: r.data?.[0] || null, deferred: r.deferred, spent: r.spent };
}

// Aggregate a player's per-competition stat blocks into season totals + minutes-weighted rating.
function aggregate(pd) {
  const stats = pd?.statistics || [];
  const s = { goals: 0, assists: 0, conceded: 0, saves: 0, shotsTotal: 0, shotsOn: 0, passesTotal: 0, passesKey: 0, tackles: 0, inter: 0, blocks: 0, duels: 0, duelsWon: 0, dribAtt: 0, dribSucc: 0, apps: 0 };
  let mins = 0, ratingSum = 0, ratingW = 0, accW = 0, pos = null;
  for (const b of stats) {
    const m = num(b.games?.minutes); if (!m) continue;
    mins += m; s.apps += num(b.games?.appearences); pos = pos || b.games?.position;
    const r = parseFloat(b.games?.rating); if (r) { ratingSum += r * m; ratingW += m; }
    s.goals += num(b.goals?.total); s.assists += num(b.goals?.assists); s.conceded += num(b.goals?.conceded); s.saves += num(b.goals?.saves);
    s.shotsTotal += num(b.shots?.total); s.shotsOn += num(b.shots?.on);
    s.passesTotal += num(b.passes?.total); s.passesKey += num(b.passes?.key); accW += num(b.passes?.accuracy) * m;
    s.tackles += num(b.tackles?.total); s.inter += num(b.tackles?.interceptions); s.blocks += num(b.tackles?.blocks);
    s.duels += num(b.duels?.total); s.duelsWon += num(b.duels?.won);
    s.dribAtt += num(b.dribbles?.attempts); s.dribSucc += num(b.dribbles?.success);
  }
  return { mins, apps: s.apps, rating: ratingW ? ratingSum / ratingW : 0, passAcc: mins ? accW / mins : 0, pos: POSMAP[pos] || "MID", s };
}

export function scorePlayer(meta, pd) {
  const a = aggregate(pd);
  const pos = POSMAP[meta.position] || a.pos;
  const p90 = a.mins > 0 ? a.mins / 90 : 0;
  const per90 = (v) => (p90 > 0 ? v / p90 : 0);
  const duelWonPct = a.s.duels ? (a.s.duelsWon / a.s.duels) * 100 : 0;
  const dribPct = a.s.dribAtt ? (a.s.dribSucc / a.s.dribAtt) * 100 : 0;
  const thin = a.mins < 270; // <3 games of data

  const attack = Math.round(0.4 * scale(per90(a.s.goals), 0.7) + 0.25 * scale(per90(a.s.assists), 0.45) + 0.2 * scale(per90(a.s.shotsOn), 1.3) + 0.15 * scale(per90(a.s.passesKey), 2.5));
  const defense = Math.round(pos === "GK"
    ? 0.5 * scale(per90(a.s.saves), 3.2) + 0.5 * clamp(100 - scale(per90(a.s.conceded), 1.8), 0, 100)
    : 0.4 * scale(per90(a.s.tackles), 3.2) + 0.3 * scale(per90(a.s.inter), 2.2) + 0.15 * scale(per90(a.s.blocks), 1.2) + 0.15 * scale(duelWonPct, 70));
  const technique = Math.round(0.35 * scale(a.passAcc - 50, 45) + 0.25 * scale(dribPct, 70) + 0.2 * scale(per90(a.s.passesKey), 2.5) + 0.2 * ratingScore(a.rating));
  const endurance = Math.round(0.7 * scale(a.mins, 2800) + 0.3 * scale(a.apps, 34));
  // Free plan has no current injury feed; use a soft durability proxy and flag it.
  const injury_risk = Math.round(clamp(45 - endurance * 0.4, 5, 45));
  const overall = Math.round(a.rating ? ratingScore(a.rating) : pos === "FWD" ? attack : pos === "GK" || pos === "DEF" ? defense : (attack + technique) / 2);

  return {
    id: meta.id, name: meta.name, pos, number: meta.number, age: meta.age, minutes: a.mins, apps: a.apps,
    goals: a.s.goals, assists: a.s.assists, saves: a.s.saves, conceded: a.s.conceded, pass_acc: Math.round(a.passAcc),
    rating: Math.round(a.rating * 100) / 100, qualified: !thin && a.mins >= 450,
    attack, defense, technique, endurance, injury_risk, overall, injury_data: false,
  };
}

// Score a team's squad from cache (and optionally fetch missing players within budget).
export async function squadScored(teamName, { allowFetch = false } = {}) {
  const nt = await nationalTeamId(teamName, { allowFetch });
  if (!nt) return { team: teamName, found: false, players: [], missing: [], cachedCount: 0 };
  const roster = await getSquad(nt.id, { allowFetch });
  const players = [], missing = [];
  for (const m of roster) {
    const { data } = await getPlayer(m.id, { allowFetch });
    if (data) players.push(scorePlayer(m, data));
    else missing.push({ id: m.id, name: m.name });
  }
  // Manifest is keyed on the REQUESTED (schedule) name, not the API's spelling, so the
  // UI and the prediction router can match it against fixture team names directly.
  const result = { team: teamName, apiName: nt.name, teamId: nt.id, found: true, rosterSize: roster.length, players, missing, cachedCount: players.length, remaining: budget().remaining };
  if (players.length) updateManifest(teamName, { id: nt.id, apiName: nt.name, players: players.length, rosterSize: roster.length, complete: missing.length === 0, season: SEASON });
  return result;
}

const W_ATT = { FWD: 1.0, MID: 0.75, DEF: 0.30, GK: 0.05 };
const W_DEF = { GK: 1.0, DEF: 1.0, MID: 0.55, FWD: 0.20 };
const round2 = (x) => Math.round(x * 100) / 100;
export function teamRating(scored) {
  const xi = pickXI(scored.players);
  if (xi.length < 7) return { attack: 1.0, defense: 1.0, players: xi.length, complete: false };
  const wmean = (key, w) => { let s = 0, ww = 0; for (const p of xi) { const k = w[p.pos] || 0; s += p[key] * k; ww += k; } return ww ? s / ww : 50; };
  const atk = wmean("attack", W_ATT), def = wmean("defense", W_DEF);
  return { attack: round2(0.6 + (atk / 100) * 0.9), defense: round2(1.4 - (def / 100) * 0.9), players: xi.length, complete: scored.missing.length === 0, mean_attack: Math.round(atk), mean_defense: Math.round(def), mean_rating: round2(xi.reduce((s, p) => s + p.rating, 0) / xi.length) };
}
export function pickXI(players) {
  const want = { GK: 1, DEF: 4, MID: 3, FWD: 3 };
  const q = players.filter((p) => p.qualified).length >= 11 ? players.filter((p) => p.qualified) : players;
  const xi = [];
  for (const pos of ["GK", "DEF", "MID", "FWD"]) xi.push(...q.filter((p) => p.pos === pos).sort((a, b) => b.minutes - a.minutes).slice(0, want[pos]));
  return xi;
}

// A "performance recap of the year" computed from the squad's real 2024/25 club stats.
export function teamRecap(scored) {
  const players = scored.players || [];
  const q = players.filter((p) => p.minutes > 0);
  const counts = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const p of players) counts[p.pos] = (counts[p.pos] || 0) + 1;
  const top = (arr, k, n = 3) => [...arr].sort((a, b) => b[k] - a[k]).slice(0, n).map((p) => ({ name: p.name, pos: p.pos, value: p[k] }));
  const sum = (k) => q.reduce((s, p) => s + (p[k] || 0), 0);
  const rt = teamRating(scored);
  return {
    team: scored.team, season: "2024/25", squad_size: players.length, complete: scored.missing.length === 0, counts,
    avg_rating: q.length ? round2(q.reduce((s, p) => s + p.rating, 0) / q.length) : 0,
    total_goals: sum("goals"), total_assists: sum("assists"),
    top_rated: top(q, "rating"),
    top_attack: top(q.filter((p) => ["FWD", "MID"].includes(p.pos)), "attack"),
    top_defense: top(q.filter((p) => ["GK", "DEF"].includes(p.pos)), "defense"),
    rating: rt,
  };
}
// A short factual description string (no LLM): grounded in the recap.
export function teamDescription(scored) {
  const r = teamRecap(scored);
  const ta = r.top_attack[0], td = r.top_defense[0];
  const lean = r.rating.attack - 1 > 1 - r.rating.defense ? "attack-minded" : "defensively solid";
  const art = /^[aeiou]/i.test(lean) ? "An" : "A";
  return `${art} ${lean} side. The called-up players averaged a ${r.avg_rating} match rating across 2024/25 and scored ${r.total_goals} club goals between them.`
    + (ta ? ` ${ta.name} leads the attack (${ta.value}/100)` : "")
    + (td ? `, ${td.name} anchors the defense (${td.value}/100).` : ".")
    + ` Modelled strength: attack ${r.rating.attack}, defense ${r.rating.defense} (1.0 = average).`;
}
