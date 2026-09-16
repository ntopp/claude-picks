export type League = 'nfl' | 'cfb';

export type Settings = {
  unitDollars: number;
  bankrollUnits: number;
  defaultUnits: number;
  maxUnitsPerBet: number;
  maxPicksPerWeek: number;
  minConfidence: number;
  lineTolerance: number;
  maxFavoritePrice: number;
  autoScan: boolean;
  webSearch: boolean;
};

export type Status = {
  anthropicConfigured: boolean;
  model: string;
  displayTz: string;
  notifications: boolean;
  settings: Settings;
  upcoming: Record<League, { season: number; week: number } | null>;
  scanRunning: boolean;
  pending: number;
};

export type Proposal = {
  id: number;
  run_id: number | null;
  created_at: string;
  expires_at: string;
  game_id: string;
  league: League;
  season: number;
  week: number;
  kickoff: string;
  matchup: string;
  market: 'spread' | 'total' | 'moneyline';
  side: 'home' | 'away' | 'over' | 'under';
  pick: string;
  line: number | null;
  price: number;
  units: number;
  confidence: number;
  edge_type: string;
  thesis: string;
  bear_case: string;
  key_factors: string[];
  status: 'pending' | 'executed' | 'passed' | 'expired' | 'void';
  origin: 'engine' | 'lean';
  decided_at: string | null;
  decision_note: string | null;
  executed_units: number | null;
  result: 'win' | 'loss' | 'push' | null;
  cover_margin: number | null;
  units_net: number | null;
  closing_line: number | null;
  closing_price: number | null;
  clv: number | null;
  graded_at: string | null;
  game: {
    status: string;
    home_abbr: string;
    away_abbr: string;
    home_score: number | null;
    away_score: number | null;
    home_rank: number | null;
    away_rank: number | null;
    neutral: boolean;
    lines_updated_at: string | null;
  } | null;
  currentLine: number | null;
  currentPrice: number | null;
  betLink: string | null;
};

export type Bucket = {
  n: number;
  wins: number;
  losses: number;
  pushes: number;
  winRate: number | null;
  staked: number;
  net: number;
  roi: number | null;
  avgClv: number | null;
  clvBeatRate: number | null;
};

export type Scoreboard = {
  generatedAt: string;
  breakEven: number;
  unitDollars: number;
  bankroll: { start: number; now: number; peak: number; drawdown: number };
  engine: Bucket;
  human: Bucket;
  passed: Bucket;
  leans: Bucket;
  pending: number;
  humanEdge: { verdict: string; executedRoi: number | null; passedRoi: number | null };
  byLeague: Record<string, Bucket>;
  byMarket: Record<string, Bucket>;
  byEdge: Record<string, Bucket>;
  byConfidence: Record<string, Bucket>;
  byWeek: { key: string; label: string; engine: Bucket; human: Bucket }[];
  series: { id: number; kickoff: string; pick: string; result: string; executed: boolean; engineCum: number; humanCum: number }[];
};

export type Dashboard = {
  pending: Proposal[];
  live: Proposal[];
  passed: Proposal[];
  recent: Proposal[];
  scoreboard: { engine: Bucket; human: Bucket; bankroll: Scoreboard['bankroll']; breakEven: number; unitDollars: number };
  settings: Settings;
};

export type Run = {
  id: number;
  started_at: string;
  finished_at: string | null;
  kind: string;
  engine: string;
  leagues: string;
  week_label: string | null;
  summary: string | null;
  error: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
};

export type RunDetail = Run & {
  response: {
    week_summary: string;
    passes: { game_id: string; note: string }[];
    teaching_note: string;
    model?: string;
    red_summary?: string | null;
    dropped?: { game_id: string; pick: string; reason: string }[];
    searches?: number;
  } | null;
  proposals: Proposal[];
};

export type Lines = {
  provider: string;
  spreadHome: number | null;
  spreadHomePrice: number | null;
  spreadAwayPrice: number | null;
  total: number | null;
  overPrice: number | null;
  underPrice: number | null;
  mlHome: number | null;
  mlAway: number | null;
};

export type BetLinks = { provider: string; spreadHome: string | null; spreadAway: string | null; over: string | null; under: string | null; mlHome: string | null; mlAway: string | null };

export type SlateGame = {
  id: string;
  kickoff: string;
  name: string;
  home: { abbr: string; name: string; rank: number | null; score: number | null };
  away: { abbr: string; name: string; rank: number | null; score: number | null };
  neutral: boolean;
  status: string;
  lines: Lines | null;
  open: Lines | null;
  links: BetLinks | null;
  view: { lean: string; confidence: number | null; note: string | null; at: string | null } | null;
  proposal: { id: number; pick: string; status: string; confidence: number; result: string | null; origin: string | null } | null;
};
export type Slate = { league: League; season: number | null; week: number | null; games: SlateGame[] };

export type WeekTab = {
  key: string;
  label: string;
  sublabel: string;
  season: number;
  nfl: { season: number; week: number } | null;
  cfb: { season: number; week: number } | null;
  start: string;
  end: string;
  current: boolean;
  picks: number;
  pending: number;
};
export type WeekData = {
  tab: WeekTab;
  pending: Proposal[];
  open: Proposal[];
  passed: Proposal[];
  settled: Proposal[];
  slates: { nfl: Slate | null; cfb: Slate | null };
};

export type ReviewRow = { id: number; created_at: string; label: string; report_md: string; narrative: string | null };

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) throw new ApiError(res.status, (body as { error?: string })?.error ?? res.statusText);
  return body as T;
}

export const api = {
  status: () => call<Status>('/status'),
  dashboard: () => call<Dashboard>('/dashboard'),
  proposals: (q: { status?: string; graded?: boolean } = {}) => {
    const p = new URLSearchParams();
    if (q.status) p.set('status', q.status);
    if (q.graded !== undefined) p.set('graded', String(q.graded));
    return call<Proposal[]>(`/proposals${p.size ? '?' + p : ''}`);
  },
  execute: (id: number, units: number, note?: string) => call<{ ok: boolean }>(`/proposals/${id}/execute`, { method: 'POST', body: JSON.stringify({ units, note }) }),
  pass: (id: number, note?: string) => call<{ ok: boolean }>(`/proposals/${id}/pass`, { method: 'POST', body: JSON.stringify({ note }) }),
  undo: (id: number) => call<{ ok: boolean }>(`/proposals/${id}/undo`, { method: 'POST' }),
  scoreboard: () => call<Scoreboard>('/scoreboard'),
  slate: (league: League) => call<Slate>(`/slate?league=${league}`),
  weeks: () => call<WeekTab[]>('/weeks'),
  week: (key: string) => call<WeekData>(`/week/${key}`),
  executeLean: (gameId: string, units: number, note?: string) => call<{ ok: boolean; id: number; pick: string }>(`/board/${gameId}/execute`, { method: 'POST', body: JSON.stringify({ units, note }) }),
  runs: () => call<Run[]>('/runs'),
  run: (id: number) => call<RunDetail>(`/runs/${id}`),
  scan: (note?: string, leagues?: League[]) => call<{ started: boolean }>('/scan', { method: 'POST', body: JSON.stringify({ note, leagues }) }),
  grade: () => call<{ refreshed: number; graded: number }>('/grade', { method: 'POST' }),
  packet: (leagues?: League[]) => call<{ markdown: string; games: number }>('/packet', { method: 'POST', body: JSON.stringify({ leagues }) }),
  settings: () => call<Settings>('/settings'),
  saveSettings: (patch: Partial<Settings>) => call<Settings>('/settings', { method: 'PUT', body: JSON.stringify(patch) }),
  events: () => call<{ id: number; ts: string; level: string; message: string }[]>('/events?limit=60'),
  reviews: () => call<ReviewRow[]>('/reviews'),
  runReview: () => call<{ id: number; report: string }>('/reviews/run', { method: 'POST' }),
};

export const fmtUnits = (n: number | null | undefined, dp = 2) => (n === null || n === undefined || !Number.isFinite(n) ? '–' : `${n > 0 ? '+' : ''}${n.toFixed(dp)}u`);
export const fmtPct = (n: number | null | undefined, dp = 1) => (n === null || n === undefined || !Number.isFinite(n) ? '–' : `${(n * 100).toFixed(dp)}%`);
export const fmtSignedPct = (n: number | null | undefined, dp = 1) => (n === null || n === undefined || !Number.isFinite(n) ? '–' : `${n > 0 ? '+' : ''}${(n * 100).toFixed(dp)}%`);
export const fmtPrice = (p: number | null | undefined) => (p === null || p === undefined ? '–' : p > 0 ? `+${p}` : `${p}`);
export const fmtLine = (l: number | null | undefined) => (l === null || l === undefined ? '–' : l === 0 ? 'PK' : l > 0 ? `+${l}` : `${l}`);
export const fmtMoney = (units: number, unitDollars: number) => {
  const n = units * unitDollars;
  return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
};
export const fmtTime = (iso: string | null | undefined, tz?: string) =>
  iso ? new Date(iso).toLocaleString(undefined, { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '–';
export const signClass = (n: number | null | undefined) => (n === null || n === undefined ? '' : n > 0 ? 'pos' : n < 0 ? 'neg' : '');
export const leagueLabel = (l: League) => (l === 'nfl' ? 'NFL' : 'CFB');
