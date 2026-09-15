import { useMemo, useState } from 'react';
import type { Scoreboard } from '../api';

type Point = Scoreboard['series'][number];

/**
 * Cumulative units after each settled pick. Two series: the engine (every pick at its
 * proposed stake) and you (executed picks at your stake). Hover for the pick.
 */
export function UnitsChart({ series }: { series: Point[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 800;
  const H = 240;
  const pad = { l: 44, r: 12, t: 12, b: 24 };

  const model = useMemo(() => {
    const pts = [{ id: 0, kickoff: '', pick: 'start', result: '', executed: false, engineCum: 0, humanCum: 0 }, ...series];
    const ys = pts.flatMap((p) => [p.engineCum, p.humanCum]);
    const min = Math.min(0, ...ys);
    const max = Math.max(0, ...ys);
    const span = max - min || 1;
    const x = (i: number) => pad.l + (i / Math.max(1, pts.length - 1)) * (W - pad.l - pad.r);
    const y = (v: number) => pad.t + (1 - (v - min) / span) * (H - pad.t - pad.b);
    const path = (key: 'engineCum' | 'humanCum') => pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ');
    // 4 horizontal grid lines at round unit values.
    const step = niceStep(span / 4);
    const ticks: number[] = [];
    for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) ticks.push(Math.round(v * 100) / 100);
    return { pts, x, y, path, ticks, min, max };
  }, [series]);

  if (series.length === 0) return <div className="empty">The chart fills in as picks settle.</div>;
  const { pts, x, y, path, ticks } = model;
  const h = hover !== null ? pts[hover] : null;

  return (
    <div className="chart-wrap">
      <svg
        className="chart"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - rect.left) / rect.width) * W;
          const i = Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (pts.length - 1));
          setHover(Math.max(0, Math.min(pts.length - 1, i)));
        }}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line className={t === 0 ? 'zero' : 'grid-line'} x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} />
            <text className="axis" x={pad.l - 6} y={y(t) + 4} textAnchor="end">
              {t > 0 ? '+' : ''}
              {t}u
            </text>
          </g>
        ))}
        <text className="axis" x={pad.l} y={H - 6}>
          first pick
        </text>
        <text className="axis" x={W - pad.r} y={H - 6} textAnchor="end">
          latest ({series.length} settled)
        </text>
        <path className="series engine" d={path('engineCum')} />
        <path className="series" d={path('humanCum')} />
        {h && hover !== null && (
          <g>
            <line className="crosshair" x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} />
            <circle className="marker engine" cx={x(hover)} cy={y(h.engineCum)} r={4} />
            <circle className="marker you" cx={x(hover)} cy={y(h.humanCum)} r={4} />
          </g>
        )}
      </svg>
      <div className="chart-legend">
        <span>
          <i style={{ background: 'var(--accent-2)' }} />
          Engine (all picks)
        </span>
        <span>
          <i style={{ background: 'var(--accent)' }} />
          You (executed)
        </span>
      </div>
      {h && hover !== null && hover > 0 && (
        <div className="chart-tip" style={{ left: `${(x(hover) / W) * 100}%`, top: 8, transform: x(hover) > W * 0.6 ? 'translateX(-105%)' : 'translateX(8px)' }}>
          <div>
            <b>{h.result.toUpperCase()}</b> {h.pick}
            {h.executed ? '' : ' (not executed)'}
          </div>
          <div className="muted">
            engine {h.engineCum > 0 ? '+' : ''}
            {h.engineCum}u · you {h.humanCum > 0 ? '+' : ''}
            {h.humanCum}u
          </div>
        </div>
      )}
    </div>
  );
}

function niceStep(raw: number) {
  const pow = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const f = raw / pow;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * pow;
}
