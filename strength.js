// Strength prior for all 48 tournament teams: an Elo-like index reflecting public team
// strength (a public global-football Elo ranking ballpark, mid-2026), converted to the
// attack/defense multipliers the Poisson model uses. The whole-tournament simulation needs
// a credible rating for EVERY team, but only a handful have squad-level data, and raw
// tournament-history ratings are too noisy (tiny samples) to rank 48 teams. This prior keeps
// the favourites the favourites. Cached nations get a small nudge from their squad rating.
// Source: public strength rankings, not internal data.

export const ELO = {
  Spain: 2080, Argentina: 2075, France: 2065, England: 2055, Brazil: 2045, Portugal: 2035,
  Germany: 2005, Netherlands: 1985, Belgium: 1955, Norway: 1945, Croatia: 1945, Colombia: 1945,
  Uruguay: 1940, Morocco: 1935, Switzerland: 1910, Senegal: 1900, Japan: 1900, USA: 1895,
  Mexico: 1885, Ecuador: 1880, Turkey: 1880, Austria: 1875, "Ivory Coast": 1865, "South Korea": 1865,
  Sweden: 1865, Egypt: 1855, Canada: 1855, Australia: 1850, Iran: 1850, Algeria: 1850,
  "Czech Republic": 1845, Scotland: 1840, "Bosnia & Herzegovina": 1835, Ghana: 1830, Paraguay: 1830,
  "DR Congo": 1825, Tunisia: 1815, "Saudi Arabia": 1810, Qatar: 1805, Uzbekistan: 1805,
  "South Africa": 1800, Panama: 1795, Iraq: 1795, Jordan: 1775, "New Zealand": 1745,
  "Cape Verde": 1735, Haiti: 1730, "Curaçao": 1715,
};
const DEFAULT_ELO = 1820;
const K = 0.2; // attack/defense spread; tuned so top teams reach the QF ~45-55% of the time

export function eloToRating(elo) {
  const s = (elo - 1890) / 130;
  const clamp = (x) => Math.max(0.72, Math.min(1.32, x));
  return { attack: Math.round(clamp(1 + K * s) * 100) / 100, defense: Math.round(clamp(1 - K * s) * 100) / 100, elo: Math.round(elo) };
}

// playerMeanRating (optional, ~7.1-7.4 for cached nations) nudges the Elo by squad quality.
export function strengthFor(team, playerMeanRating) {
  const known = Object.prototype.hasOwnProperty.call(ELO, team);
  let elo = known ? ELO[team] : DEFAULT_ELO;
  if (playerMeanRating) elo += (playerMeanRating - 7.15) * 60;
  return { ...eloToRating(elo), known };
}
