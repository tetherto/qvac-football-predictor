# QVAC Football Predictor 2026

A local-AI match-day show for the 2026 international football tournament. Pick any two of the 48 qualified nations and watch the match play out: an animated pitch, full-screen goal banners, confetti, stadium sound, and a sarcastic AI pundit. Or simulate the whole tournament 5,000 times and watch the title race unfold match by match.

Everything intelligent runs on your machine. The LLM (Qwen3 via the [QVAC SDK](https://github.com/tetherto/qvac)) is 100% local: no cloud AI, no API keys for the model, no per-token cost. The only thing that touches the internet is football data.

## What you get

- **Match prediction**: a 10,000-run Monte Carlo simulation drives the odds, a local LLM writes the pundit's read and the key factors, and the most likely scoreline plays out as an animated broadcast (live scoreboard, goal and red-card overlays, sound effects). No spoilers: the verdict and the statistics land at the final whistle.
- **Whole-tournament simulation**: 5,000 full tournaments (group stage, best third places, knockout bracket). You watch the predicted tournament play out match by match, then get the champion, per-stage survival odds, a probability flow chart, and fun facts mined from the runs ("even the biggest outsider won twice, you never know").
- **Build your bracket**: the real groups and knockout structure; tap teams to advance them to your own final.
- **Statistical honesty**: win/draw/loss probabilities, a 100-dot frequency grid ("38 of 100 sims"), expected goals, and goal-margin distributions. The maths is computed in plain JavaScript on your machine, never hallucinated by the model.

## Requirements

- **Node.js** 22.17 or higher
- A GPU-capable machine (macOS Apple Silicon, Linux with Vulkan, or Windows with Vulkan). CPU fallback works but is slow.
- ~3 GB free disk for the model cache (Qwen3 4B Q4; a 1.7B fallback is used on machines with less RAM)
- An internet connection for football data

Check your machine first:

```bash
npx -y @qvac/sdk doctor
```

## Quickstart

```bash
npm install
npm start
# open http://localhost:3060
```

The first prediction downloads and loads the model (a few minutes once, cached afterwards).

## Better data (optional, recommended)

Out of the box the app uses a public fixtures dataset and a public-rankings strength prior. For player-level squads, Moneyball ratings, and an AI pundit who names real players, add an [API-Football](https://www.api-football.com/) key:

```bash
cp .env.example .env.local
# put your APIFOOTBALL_KEY in .env.local
npm run prefetch     # caches all 48 squads + per-player season stats to disk
```

`npm run prefetch` is incremental and budget-aware: it reads your plan's daily limits from the API's rate-limit headers, throttles itself, stops at a safety floor, and resumes where it left off on the next run. On the free plan (100 requests/day) it fills a few nations per day; on a paid plan it does all 48 in one run.

## How the prediction works (and what it is not)

- All 48 teams sit on one **Elo-style strength prior** built from public global football rankings, converted into attack/defense multipliers for an independent-Poisson goals model. Cached nations get a small nudge from their real squad quality.
- A **Monte Carlo simulation** (10,000 runs per match, 5,000 full tournaments) turns those multipliers into probabilities. The model's win percentages sum to exactly 1.0 and the per-stage reach probabilities are internally consistent.
- The **local LLM does not invent the numbers**. It reads the simulation results and the real squad profiles, then writes the analysis and the entertainment on top.
- The animated playthrough lands on the most likely scoreline from the simulation. It is a dramatization of one outcome, clearly labelled.

This is a demo of local AI orchestration on real data, not betting advice.

## Endpoints

| Route | What it does |
|---|---|
| `GET /` | the app |
| `POST /api/predict` | SSE stream: squads, Monte Carlo, the model's reasoning, pundit text, structured verdict |
| `GET /api/simulate-tournament?runs=5000` | full tournament Monte Carlo: per-stage odds, the predicted run match by match, fun facts |
| `GET /api/schedule` | groups, fixtures, knockout structure, cached-nations list |
| `GET /api/nations`, `GET /api/nation?team=` | cached squad browser (player-level data) |

## License

The code is licensed under **Apache 2.0**. See [LICENSE](LICENSE).

## Data sources and their terms

This applies to the **data**, not the code, and matters if you deploy a public instance.

- **Fixtures, groups and bracket** come from the [openfootball/worldcup.json](https://github.com/openfootball/worldcup.json) dataset, dedicated to the public domain (**CC0-1.0**), used and redistributable with no restrictions.
- **Player squads and stats** come from [API-Football](https://www.api-football.com/), fetched at runtime with **your own API key** under [their terms](https://www.api-football.com/terms). This repository does **not** contain or redistribute any API-Football data: the on-disk cache and the key live only in your gitignored `.env.local` and `cache/`. Per their terms you may not resell the data, and API-Football does not itself grant a licence to publish it: if you host a public instance that displays the data, you are responsible for obtaining any necessary permission from the rights holders. The app runs without a key too (it falls back to the public fixtures and an Elo strength prior).
- **Player names** shown in the UI are factual; the **ratings and probabilities** are this project's own computations derived from the stats, not the raw provider data.
