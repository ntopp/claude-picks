# Claude Picks

A paper-money experiment: can Claude, with everything it can read — lines and line movement, injury reports, weather, rest and travel, coaching changes, scouting and beat-writer news — beat the closing line and the 52.4% break-even rate on NFL and college football bets over a season?

Claude writes **proposals** (game, market, side, line, price, stake, confidence, thesis, bear case). You review them on a local dashboard and click **Execute** or **Pass**. After the games, the app pulls finals, settles every proposal, and keeps score — for the engine on every pick it made, and for you on the picks you took.

**Nothing is ever placed with a sportsbook.** Execute logs a paper bet. The Execute / Pass buttons are the same shape as [claude-trader](../claude-trader) so the two experiments read the same way.

## What it does

- **Packet** — for each league, the upcoming week's slate from ESPN's public API: kickoff, records, rankings, DraftKings spread / total / moneyline with prices, the opener and how far it has moved, weather, ESPN's FPI projection, and per game the injury list, last five results and any other book's number.
- **Engine** — either the app calls the Claude API (with web search for injury / weather / coaching news, then an adversarial red-team pass), or you run the analysis from a Claude Code session with `npm run packet` → reason → `npm run propose`. Both write to the same proposal queue.
- **Rails** — deterministic, at insert: one pick per game, weekly pick cap, minimum confidence, stake cap, no laying heavy moneyline favorites, stale-line rejection, expiry at kickoff.
- **Grading** — every 30 minutes the server refreshes any week with an open pick, freezes the closing line at kickoff, and settles finals. Executed, passed and expired picks are all graded.
- **Scoreboard** — record and win rate against the break-even line, units and ROI, closing line value, engine vs you vs what you passed, and breakdowns by league, market, edge type, confidence (calibration) and week. A written review each Tuesday.

## Setup

Node 24+.

```bash
npm install
```

```bash
npm run dev:server
```

```bash
npm run dev:web
```

Open http://localhost:5174. (`npm start` runs both with auto-restart; `npm run stop` kills stray server processes.)

Optional `.env` (copy `.env.example`): `ANTHROPIC_API_KEY` lets the app run scans itself from the Runs tab or on a Wednesday schedule. Without it, use the Claude Code session flow below. `NTFY_TOPIC` sends a push when picks are proposed or settled.

## Phone

The dashboard installs as an app (Add to Home Screen) and is laid out for a phone: big Execute / Pass buttons, one tap each, Undo until kickoff.

1. **Reach the PC.** Install [Tailscale](https://tailscale.com) on the PC and the phone, sign in to the same account. The server prints the phone address on startup (`http://100.x.y.z:5174`); it is also what pushes link to. Without Tailscale, the LAN address Vite prints works on home Wi-Fi only, or set `DASHBOARD_URL` in `.env`.
2. **Get pushes.** Install the [ntfy](https://ntfy.sh) app, subscribe to the topic in `.env` (`NTFY_TOPIC`, treat it like a password), then `npm run notify:test`. You get a push when picks are proposed and when bets settle; tapping opens the dashboard.
3. **Install.** Open the address in the phone browser and choose Add to Home Screen.

## Public page for friends

`npm run publish` renders a read-only page — this week's picks with reasoning, the board, the season scoreboard, prior weeks collapsed — to `docs/index.html` and pushes it; GitHub Pages serves it (Settings → Pages → Deploy from branch → main, /docs). It publishes itself Thursday after the picks and Monday morning after the weekend grades. Set `PAGES_URL` in `.env` and a `NTFY_FRIENDS_TOPIC`; anyone who subscribes to that topic in the ntfy app gets a "picks are up" / "results are in" push with the link, and nothing else.

## Weekly workflow

| When | What |
|---|---|
| Thu 8:30 AM | Lines are up and Wednesday practice reports are in. A scheduled Claude Code task runs the session flow (packet → research → propose) and pushes the picks to your phone. Or run a scan yourself from the Runs tab. |
| Thu–Sat | Execute or Pass each proposal, with a note if you like. Line movement since the pick is shown on the card. |
| Thu–Mon | Games play; the server grades as they finish. Picks tab shows live scores on your open bets. |
| Mon 8:00 AM | Lines-only snapshot of the next slate; public page refreshed with the weekend's results. |
| Tue 8:30 AM | A Claude session reviews the week: thesis vs outcome for each pick, leans by confidence, baselines, passes. Writes lessons; proposes playbook changes only with enough evidence, for you to adopt or reject. |

### Claude Code session engine

```bash
npm run packet
```

Point Claude at the output (or `data/packet-latest.json`), have it read the playbook in `server/src/engine/prompt.ts`, research with web search, and write a response matching `SlateResponseSchema` in `server/src/engine/schema.ts` to `data/response.json`. Then:

```bash
npm run propose -- --file data/response.json --kind weekly
```

Other commands: `npm run grade` (settle now), `npm run review` (write a review now), `npm run scan` (API engine end to end), `npm test` (settlement / CLV math).

## Reading the scoreboard

- **Win rate vs break-even.** At -110 you need 52.38% to profit. The bar chart draws that line.
- **Closing line value (CLV).** How many points better your number was than where the market closed. Bettors who beat the close consistently are the ones who win long term; it is meaningful after ~30 picks, long before win rate is.
- **Engine vs you vs passed.** The engine is scored on everything it proposed. You are scored on what you executed at your stake. Passed picks are graded as if bet, so the app can tell you whether your filter is adding value or leaving money on the table.
- **By confidence.** A calibrated engine's 7s should win more often than its 5s. If they don't, confidence is noise. The board leans make this measurable within weeks: every read on every game is graded as a 1u bet.
- **Baselines.** Home dog, road dog, every favorite, every over, every under — at the closing line on the same games. "+3 units" only means something if it beats these.
- **Lessons.** The Tuesday review writes what it learned; it may propose a playbook change only past minimum sample sizes, and you decide. Adopted proposals ride into every packet.

## Layout

```
server/src
  espn.ts         ESPN scoreboard / summary client, normalized games and lines
  slate.ts        builds the packet, records games + line snapshots, renders markdown
  odds.ts         American odds math, settlement, closing line value (unit-tested)
  engine/
    prompt.ts     the playbook and red-team prompts
    schema.ts     proposal / response schemas (zod)
    claude.ts     API engine (structured output + web search)
    run.ts        insert proposals through the rails
  grading.ts      refresh scores, freeze closing lines, settle
  stats.ts        the scoreboard
  review.ts       weekly review
  routes.ts       API for the dashboard
  scheduler.ts    grading (5 min live / 30 min), Monday snapshot + publish, Wednesday scan, Tuesday review
  weeks.ts        experiment weeks (NFL week + its college week), board slates
  publish.ts      the public read-only page (docs/index.html) and its git push
web/src
  pages/          Picks, Results, Scoreboard, Runs, Settings
  components/     ProposalCard (execute / pass), UnitsChart
```

Data lives in `data/picks.db` (gitignored).
