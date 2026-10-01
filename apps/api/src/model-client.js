import { z } from 'zod';
import { isUtcTimestamp } from './validation.js';

const metric = z.number().finite().nullable();
const aggregateMetrics = z.object({
  mae: metric,
  rmse: metric,
  smape: metric,
  mase: metric,
  interval_coverage: metric.optional(),
  interval_mean_width: metric.optional(),
});
const metrics = aggregateMetrics
  .extend({
    by_horizon: z
      .array(aggregateMetrics.extend({ horizon: z.number().int().positive() }))
      .max(90)
      .optional(),
    origin_count: z.number().int().nonnegative().optional(),
  })
  .passthrough();
// Python's generated timestamps have microsecond precision; ingested timestamps
// deliberately remain millisecond precision because JavaScript/Postgres ingest
// comparisons use milliseconds. Validate calendar fields after truncating only
// the generated submillisecond suffix.
function isResultTimestamp(value) {
  return typeof value === 'string' && isUtcTimestamp(value.replace(/\.(\d{3})\d{1,3}Z$/, '.$1Z'));
}
const point = z
  .object({
    timestamp: z.string().refine(isResultTimestamp),
    horizon: z.number().int().positive(),
    predicted: z.number().finite(),
    lower: z.number().finite().nullable().optional(),
    upper: z.number().finite().nullable().optional(),
  })
  .passthrough();
const resultSchema = z
  .object({
    run_id: z.uuid(),
    series_id: z.uuid(),
    selected_model: z.string().min(1).max(120),
    trained_at: z.string().refine(isResultTimestamp),
    data_cutoff: z.string().refine(isResultTimestamp),
    data_hash: z.string().regex(/^[a-f0-9]{64}$/),
    sample_count: z.number().int().positive(),
    config: z.record(z.string(), z.unknown()),
    split: z.record(z.string(), z.unknown()),
    metrics,
    candidates: z
      .array(
        z.object({ name: z.string(), validation_mae: metric, test_metrics: metrics }).passthrough(),
      )
      .max(20),
    forecast: z.array(point).min(1).max(90),
    backtest: z.array(point.extend({ actual: z.number().finite() })).max(20000),
    history: z
      .array(
        z.object({ timestamp: z.string().refine(isResultTimestamp), value: z.number().finite() }),
      )
      .max(50000),
    warnings: z.array(z.string()).max(100),
    artifact_path: z.string().max(256),
  })
  .passthrough();

export class ModelError extends Error {
  constructor(message, retryable = true) {
    super(message);
    this.retryable = retryable;
  }
}

function finiteTree(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(finiteTree);
  if (value && typeof value === 'object') return Object.values(value).every(finiteTree);
  return true;
}

export function validateModelResult(raw, job) {
  const parsed = resultSchema.safeParse(raw);
  if (!parsed.success || !finiteTree(raw))
    throw new ModelError('Model service returned an invalid result.', false);
  const result = parsed.data;
  const cutoff = job.observation_snapshot.at(-1).timestamp;
  if (
    result.run_id !== job.run_id ||
    result.series_id !== job.series_id ||
    result.sample_count !== job.observation_snapshot.length ||
    new Date(result.data_cutoff).getTime() !== new Date(cutoff).getTime() ||
    result.forecast.length !== job.config.horizon
  )
    throw new ModelError('Model result provenance does not match the requested snapshot.', false);
  const periodMs = job.config.frequency === 'h' ? 3600000 : 86400000;
  if (
    result.forecast.some(
      (point, i) =>
        point.horizon !== i + 1 ||
        new Date(point.timestamp).getTime() !== new Date(cutoff).getTime() + periodMs * (i + 1),
    )
  )
    throw new ModelError('Model service returned invalid forecast horizons.', false);
  if (
    [...result.forecast, ...result.backtest].some(
      (point) =>
        typeof point.lower === 'number' &&
        typeof point.upper === 'number' &&
        (point.lower > point.upper ||
          point.predicted < point.lower ||
          point.predicted > point.upper),
    )
  )
    throw new ModelError('Model service returned invalid prediction intervals.', false);
  if (
    Object.entries(job.config).some(([key, value]) => result.config[key] !== value) ||
    result.artifact_path !== job.run_id
  )
    throw new ModelError(
      'Model result configuration or artifact provenance does not match.',
      false,
    );
  return result;
}

export async function trainModel(config, job, signal) {
  let response;
  try {
    response = await fetch(`${config.modelUrl}/train`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Token': config.serviceToken },
      signal,
      body: JSON.stringify({
        run_id: job.run_id,
        series_id: job.series_id,
        observations: job.observation_snapshot,
        config: job.config,
      }),
    });
  } catch {
    throw new ModelError('Model service connection was interrupted or timed out.');
  }
  if (!response.ok) {
    await response.body?.cancel();
    const retryable = response.status >= 500 || [408, 429].includes(response.status);
    throw new ModelError(
      `Model service rejected training (HTTP ${response.status}). Check the observation count, cadence, split sizes, and interval calibration requirements.`,
      retryable,
    );
  }
  let size = 0;
  const chunks = [];
  try {
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 8 * 1024 * 1024)
        throw new ModelError('Model result exceeds the allowed response size.', false);
      chunks.push(chunk);
    }
    return validateModelResult(JSON.parse(Buffer.concat(chunks).toString('utf8')), job);
  } catch (error) {
    if (error instanceof ModelError) throw error;
    throw new ModelError('Model service returned an unreadable result.', false);
  }
}
