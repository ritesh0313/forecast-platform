import { useId, useState } from 'react';
import type { Backtest, Observation, Prediction } from '../types';
import { formatMetric } from '../observations';

interface Point {
  timestamp: string;
  actual?: number;
  predicted?: number;
  lower?: number | null;
  upper?: number | null;
}
export function ForecastChart({
  history = [],
  forecast = [],
  backtest,
  intervalLabel = 'Prediction interval',
}: {
  history?: Observation[];
  forecast?: Prediction[];
  backtest?: Backtest[];
  intervalLabel?: string;
}) {
  const id = useId().replace(/:/g, '');
  const [showActual, setShowActual] = useState(true);
  const [showPrediction, setShowPrediction] = useState(true);
  const [showInterval, setShowInterval] = useState(true);
  const [hover, setHover] = useState<number | null>(null);
  const rows: Point[] = backtest
    ? backtest.map((point) => ({ ...point }))
    : [
        ...history.slice(-60).map((point) => ({ timestamp: point.timestamp, actual: point.value })),
        ...forecast,
      ];
  const finite = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value);
  const values = rows
    .flatMap((row) => [row.actual, row.predicted, row.lower, row.upper])
    .filter(finite);
  if (!rows.length || !values.length)
    return <div className="chart-empty">A completed model run will populate this chart.</div>;
  const width = 760,
    height = 268,
    left = 49,
    right = 16,
    top = 19,
    bottom = 39;
  const lo = Math.min(...values),
    hi = Math.max(...values),
    padding = Math.max((hi - lo) * 0.12, Math.abs(hi) * 0.04, 0.1);
  const low = lo - padding,
    high = hi + padding;
  const x = (index: number) =>
    left + (index / Math.max(rows.length - 1, 1)) * (width - left - right);
  const y = (value: number) =>
    height - bottom - ((value - low) / (high - low)) * (height - top - bottom);
  const path = (key: 'actual' | 'predicted') =>
    rows.reduce((result, row, index) => {
      if (!finite(row[key])) return result;
      return result + `${result ? 'L' : 'M'}${x(index)},${y(row[key])} `;
    }, '');
  const predictedIndices = rows
    .map((row, index) => (finite(row.predicted) ? index : -1))
    .filter((index) => index >= 0);
  const intervalIndices = predictedIndices.filter(
    (index) => finite(rows[index].lower) && finite(rows[index].upper),
  );
  const band = intervalIndices
    .map((index) => `${x(index)},${y(rows[index].upper!)}`)
    .concat([...intervalIndices].reverse().map((index) => `${x(index)},${y(rows[index].lower!)}`))
    .join(' ');
  const futureIndex = backtest ? -1 : history.slice(-60).length;
  const dateLabel = (timestamp: string) =>
    new Date(timestamp).toLocaleDateString('en', {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
  const active = hover === null ? null : rows[hover];
  const ticks = [
    ...new Set(
      Array.from({ length: Math.min(6, rows.length) }, (_, index) =>
        Math.round((index * (rows.length - 1)) / Math.max(Math.min(6, rows.length) - 1, 1)),
      ),
    ),
  ];
  return (
    <div className="chart-shell">
      <div className="chart-legend" aria-label="Chart visibility">
        <button type="button" aria-pressed={showActual} onClick={() => setShowActual(!showActual)}>
          <span className="legend-dot actual" />
          {backtest ? 'Actual' : 'Observed'}
        </button>
        <button
          type="button"
          aria-pressed={showPrediction}
          onClick={() => setShowPrediction(!showPrediction)}
        >
          <span className="legend-dot predicted" />
          {backtest ? 'Predicted' : 'Forecast'}
        </button>
        {intervalIndices.length > 0 && (
          <button
            type="button"
            aria-pressed={showInterval}
            onClick={() => setShowInterval(!showInterval)}
          >
            <span className="legend-dot interval" />
            {intervalLabel}
          </button>
        )}
        <span className="legend-hint">Times in UTC</span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="chart-svg"
        role="img"
        aria-labelledby={`${id}title ${id}description`}
        onMouseLeave={() => setHover(null)}
      >
        <title id={`${id}title`}>
          {backtest
            ? 'Held-out actual values and one-step predictions'
            : 'Recent observations and future forecasts'}
        </title>
        <desc id={`${id}description`}>
          {rows.length} observations across {dateLabel(rows[0].timestamp)} to{' '}
          {dateLabel(rows[rows.length - 1].timestamp)}. Values range from {formatMetric(lo)} to{' '}
          {formatMetric(hi)}. The table below provides exact predictions.
        </desc>
        <defs>
          <linearGradient id={`${id}shade`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#208c83" stopOpacity=".19" />
            <stop offset="100%" stopColor="#208c83" stopOpacity=".03" />
          </linearGradient>
        </defs>
        {futureIndex >= 0 && futureIndex < rows.length && (
          <>
            <rect
              x={x(Math.max(0, futureIndex - 0.5))}
              y={top}
              width={width - right - x(Math.max(0, futureIndex - 0.5))}
              height={height - top - bottom}
              fill="#f0f7f5"
            />
            <line
              x1={x(Math.max(0, futureIndex - 0.5))}
              x2={x(Math.max(0, futureIndex - 0.5))}
              y1={top}
              y2={height - bottom}
              stroke="#a9c4c0"
              strokeDasharray="4 5"
            />
            <text
              x={Math.max(left + 8, x(Math.max(0, futureIndex - 0.5)) - 8)}
              y={top - 6}
              textAnchor="end"
              fill="#68817e"
              fontSize="10"
            >
              Forecast begins
            </text>
          </>
        )}
        {Array.from({ length: 5 }, (_, index) => {
          const value = low + (index / 4) * (high - low);
          return (
            <g key={index}>
              <line x1={left} x2={width - right} y1={y(value)} y2={y(value)} stroke="#e9eeed" />
              <text x={left - 10} y={y(value) + 4} textAnchor="end" fill="#80908d" fontSize="11">
                {formatMetric(value)}
              </text>
            </g>
          );
        })}
        {ticks.map((index) => (
          <text
            key={index}
            x={x(index)}
            y={height - 12}
            textAnchor={index === 0 ? 'start' : index === rows.length - 1 ? 'end' : 'middle'}
            fill="#80908d"
            fontSize="11"
          >
            {dateLabel(rows[index].timestamp)}
          </text>
        ))}
        {showInterval && band && <polygon points={band} fill={`url(#${id}shade)`} />}
        {showActual && (
          <path
            d={path('actual')}
            fill="none"
            stroke="#7d8d9f"
            strokeWidth="2"
            strokeLinejoin="round"
          />
        )}
        {showPrediction && (
          <path
            d={path('predicted')}
            fill="none"
            stroke="#16867c"
            strokeWidth="2.5"
            strokeLinejoin="round"
          />
        )}
        {active && hover !== null && (
          <g>
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={top}
              y2={height - bottom}
              stroke="#2a534e"
              strokeDasharray="3 4"
            />
            {finite(active.predicted) && (
              <circle
                cx={x(hover)}
                cy={y(active.predicted)}
                r="4"
                fill="#16867c"
                stroke="white"
                strokeWidth="2"
              />
            )}
            {finite(active.actual) && (
              <circle
                cx={x(hover)}
                cy={y(active.actual)}
                r="4"
                fill="#7d8d9f"
                stroke="white"
                strokeWidth="2"
              />
            )}
          </g>
        )}
        {rows.map((row, index) => (
          <rect
            key={row.timestamp}
            x={Math.max(left, x(index) - (width - left - right) / rows.length / 2)}
            y={top}
            width={(width - left - right) / rows.length}
            height={height - top - bottom}
            fill="transparent"
            onMouseEnter={() => setHover(index)}
          />
        ))}
      </svg>
      <div className="chart-tooltip" aria-live="off">
        {active ? (
          <>
            <strong>
              {new Date(active.timestamp).toLocaleString('en', {
                timeZone: 'UTC',
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </strong>
            {finite(active.actual) && <span>Actual: {formatMetric(active.actual)}</span>}
            {finite(active.predicted) && <span>Prediction: {formatMetric(active.predicted)}</span>}
            {finite(active.lower) && finite(active.upper) && (
              <span>
                Interval: {formatMetric(active.lower)}–{formatMetric(active.upper)}
              </span>
            )}
          </>
        ) : (
          <span>Hover to inspect · Exact values in the accessible data table</span>
        )}
      </div>
      <details className="chart-table">
        <summary>{backtest ? 'View held-out predictions' : 'View forecast values'}</summary>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Timestamp (UTC)</th>
                {backtest && <th scope="col">Actual</th>}
                <th scope="col">Prediction</th>
                <th scope="col">Lower</th>
                <th scope="col">Upper</th>
              </tr>
            </thead>
            <tbody>
              {rows
                .filter((row) => finite(row.predicted))
                .map((row) => (
                  <tr key={row.timestamp}>
                    <th scope="row">{new Date(row.timestamp).toISOString()}</th>
                    {backtest && <td>{formatMetric(row.actual)}</td>}
                    <td>{formatMetric(row.predicted)}</td>
                    <td>{formatMetric(row.lower)}</td>
                    <td>{formatMetric(row.upper)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
