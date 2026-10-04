import { euro } from '@/lib/format';

export interface ChartPoint {
  label: string;
  value: number;
  previous?: number;
}

/**
 * Dependency-free SVG line chart (cents). The data is also available as a table below the
 * chart, so the figures never depend on the picture alone (RGAA).
 */
export function LineChart({
  points,
  title,
  currentLabel = 'Période',
  previousLabel = 'N-1',
}: {
  points: ChartPoint[];
  title: string;
  currentLabel?: string;
  previousLabel?: string;
}) {
  const W = 720;
  const H = 240;
  const pad = { l: 56, r: 12, t: 12, b: 28 };
  const max = Math.max(1, ...points.flatMap((p) => [p.value, p.previous ?? 0]));
  const x = (i: number) =>
    pad.l + (points.length <= 1 ? 0.5 : i / (points.length - 1)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - v / max) * (H - pad.t - pad.b);
  const line = (get: (p: ChartPoint) => number | undefined) =>
    points
      .map((p, i) => ({ i, v: get(p) }))
      .filter((p): p is { i: number; v: number } => p.v !== undefined)
      .map((p, n) => `${n === 0 ? 'M' : 'L'}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`)
      .join(' ');
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const every = Math.max(1, Math.ceil(points.length / 8));
  const hasPrevious = points.some((p) => p.previous !== undefined);

  return (
    <figure className="grid gap-2">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={title}
        className="h-auto w-full text-muted-foreground"
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={pad.l}
              x2={W - pad.r}
              y1={y(max * t)}
              y2={y(max * t)}
              stroke="currentColor"
              strokeOpacity={0.2}
            />
            <text
              x={pad.l - 6}
              y={y(max * t) + 4}
              textAnchor="end"
              fontSize="10"
              fill="currentColor"
            >
              {euro(Math.round(max * t) / 100).replace(/,00\s/, ' ')}
            </text>
          </g>
        ))}
        {points.map((p, i) =>
          i % every === 0 ? (
            <text
              key={p.label}
              x={x(i)}
              y={H - 8}
              textAnchor="middle"
              fontSize="10"
              fill="currentColor"
            >
              {p.label}
            </text>
          ) : null,
        )}
        {hasPrevious ? (
          <path
            d={line((p) => p.previous)}
            fill="none"
            stroke="currentColor"
            strokeOpacity={0.6}
            strokeDasharray="5 4"
            strokeWidth={2}
          />
        ) : null}
        <path d={line((p) => p.value)} fill="none" className="stroke-primary" strokeWidth={2.5} />
        {points.map((p, i) => (
          <circle key={p.label} cx={x(i)} cy={y(p.value)} r={3} className="fill-primary">
            <title>{`${p.label} : ${euro(p.value / 100)}`}</title>
          </circle>
        ))}
      </svg>
      <figcaption className="flex flex-wrap gap-4 text-xs">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-5 bg-primary" /> {currentLabel}
        </span>
        {hasPrevious ? (
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-5 border-t-2 border-dashed border-current" />{' '}
            {previousLabel}
          </span>
        ) : null}
      </figcaption>
    </figure>
  );
}
