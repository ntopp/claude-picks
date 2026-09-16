# Claude Picks — notes for Claude Code sessions

TypeScript monorepo: `server/` (Express + SQLite via `node:sqlite`, ESPN public API) and `web/` (Vite React). Node 24. Run with `npm run dev:server` (port 8788) and `npm run dev:web` (port 5174); typecheck with `npm run typecheck`; tests with `npm test`. Sibling of `../claude-trader` and follows its conventions.

Everything is paper. "Execute" logs a bet in the DB; nothing is ever placed with a sportsbook.

## Acting as the analysis engine in a session

When the user asks for picks / a slate / proposals from a session (no `ANTHROPIC_API_KEY`):

1. `npm run packet` — prints the weekly packet (markdown) for both leagues and writes `data/packet-latest.json`. `--league nfl` or `--league cfb` for one; `--week N` to override; `--all-detail` to enrich every college game; `--no-detail` for lines only.
2. Read `server/src/engine/prompt.ts` first — the `PLAYBOOK` is the strategy. Then reason. **Use WebSearch/WebFetch**: this week's injury reports and practice participation, kickoff-time weather for outdoor games, coaching/QB changes, beat-writer news. The packet has lines, movement, ESPN injuries, last five, FPI — the edge is in what it does not have.
3. Write the honest bear case for each idea first; if it wins, put the game in `passes`. In session mode you are also the red team (`RED_TEAM` in `prompt.ts`): apply that scrutiny to your own list before saving.
4. Write JSON matching `SlateResponseSchema` (`server/src/engine/schema.ts`) to `data/response.json`. `game_id` is the ESPN id from the packet table. `line` is the PICKED side's own number (+4.5 for a dog, -4.5 for a favorite; the total for over/under). `price` is the packet's price for that side. Also fill `board`: one entry per game with a line (both leagues) — lean in market terms, confidence 1-10 (under 5 = no bet), one-line note. The dashboard shows the board under the picks, tabbed NFL / NCAA.
5. `npm run propose -- --file data/response.json --kind weekly` (or `adhoc`). The rails drop anything invalid and print why.
6. `npm run publish -- --picks` regenerates the public page (`docs/index.html`), pushes it, and pings the friends ntfy topic. Then tell the user what was proposed and why; they Execute or Pass from the dashboard. Never mark a proposal executed from a session — that is the user's action.

A desktop scheduled task (`weekly-football-picks`, Thursdays 8:30 AM) runs exactly this flow unattended; `npm run propose` sends the ntfy push itself when `NTFY_TOPIC` is set.

## Grading and feedback

- `npm run grade` refreshes scores for every week with an open pick, freezes closing lines at kickoff, and settles finals. The server does this every 30 minutes on its own.
- Every proposal is graded, executed or not. The Scoreboard tab (and `computeScoreboard()` in `server/src/stats.ts`) splits engine vs you vs passed, plus by league / market / edge type / confidence, and CLV (closing line value). Positive CLV is the earliest honest signal of edge.
- `npm run review` writes a review (auto Tuesdays 08:00). Read the latest review before a new scan when resuming after a gap.

## Conventions

- `Lines` snapshots (`server/src/odds.ts`) are always from the home team's perspective (`spreadHome`); proposals store the picked side's line. `pickedFrom()` converts.
- Proposals carry `origin`: `engine` (proposed as a pick) or `lean` (the user bet a board lean from the dashboard). The engine is scored only on `engine`; leans get their own bucket.
- Rails live in `DEFAULT_SETTINGS` (`server/src/config.ts`) and are enforced in `insertProposals` (`server/src/engine/run.ts`).
- Keep the `PLAYBOOK` system prompt stable; it is prompt-cached. Put per-scan context in the user message.
- ESPN endpoints are unofficial; if the shape changes, `server/src/espn.ts` is the only file that reads raw JSON.
