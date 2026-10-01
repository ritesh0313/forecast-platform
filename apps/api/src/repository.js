import { randomUUID } from 'node:crypto';
import { HttpError } from './errors.js';
import { transaction } from './db.js';

export const publicJobColumns = 'id, status, created_at, started_at, completed_at, error, run_id';

export async function ownedSeries(client, tenantId, seriesId, lock = false) {
  const result = await client.query(
    `SELECT id, name, frequency FROM series WHERE tenant_id = $1 AND id = $2 ${lock ? 'FOR UPDATE' : ''}`,
    [tenantId, seriesId],
  );
  if (!result.rowCount) throw new HttpError(404, 'not_found', 'Series not found.');
  return result.rows[0];
}

export async function ingestObservations(pool, tenantId, seriesId, observations) {
  return transaction(pool, async (client) => {
    const series = await ownedSeries(client, tenantId, seriesId, true);
    const timestamps = observations.map((item) => item.timestamp);
    const values = observations.map((item) => item.value);
    const conflicts = await client.query(
      `SELECT 1 FROM observations o JOIN unnest($3::timestamptz[], $4::float8[]) AS incoming(timestamp, value) ON o.timestamp = incoming.timestamp WHERE o.tenant_id = $1 AND o.series_id = $2 AND o.value <> incoming.value LIMIT 1`,
      [tenantId, seriesId, timestamps, values],
    );
    if (conflicts.rowCount)
      throw new HttpError(
        409,
        'conflicting_observation',
        'An existing timestamp has a different value. Values are immutable; use a new series for corrections.',
      );
    // Validate the complete prospective series before writing. The row lock serializes
    // ingestion with enqueue, so a job always captures an immutable consistent snapshot.
    const cadence = await client.query(
      `WITH combined AS (
      SELECT timestamp FROM observations WHERE tenant_id = $1 AND series_id = $2
      UNION SELECT unnest($3::timestamptz[])
    ), ordered AS (SELECT timestamp, lag(timestamp) OVER (ORDER BY timestamp) AS previous FROM combined)
    SELECT 1 FROM ordered WHERE previous IS NOT NULL AND timestamp - previous <> $4::interval LIMIT 1`,
      [tenantId, seriesId, timestamps, series.frequency === 'D' ? '1 day' : '1 hour'],
    );
    if (cadence.rowCount)
      throw new HttpError(
        400,
        'irregular_cadence',
        'Observations must form a continuous daily or hourly UTC series without gaps.',
      );
    const inserted = await client.query(
      `INSERT INTO observations (tenant_id, series_id, timestamp, value) SELECT $1, $2, incoming.timestamp, incoming.value FROM unnest($3::timestamptz[], $4::float8[]) AS incoming(timestamp, value) ON CONFLICT (tenant_id, series_id, timestamp) DO NOTHING`,
      [tenantId, seriesId, timestamps, values],
    );
    return inserted.rowCount;
  });
}

export async function enqueueTraining(
  pool,
  tenantId,
  seriesId,
  configForFrequency,
  maxAttempts = 3,
) {
  try {
    return await transaction(pool, async (client) => {
      const series = await ownedSeries(client, tenantId, seriesId, true);
      const config = configForFrequency(series.frequency);
      const active = await client.query(
        "SELECT id FROM training_jobs WHERE tenant_id = $1 AND series_id = $2 AND status IN ('queued', 'running')",
        [tenantId, seriesId],
      );
      if (active.rowCount)
        throw new HttpError(
          409,
          'training_active',
          'This series already has a queued or running training job.',
        );
      const rows = await client.query(
        'SELECT timestamp, value FROM observations WHERE tenant_id = $1 AND series_id = $2 ORDER BY timestamp LIMIT 50001',
        [tenantId, seriesId],
      );
      if (!rows.rowCount)
        throw new HttpError(400, 'no_observations', 'Add observations before requesting training.');
      if (rows.rowCount > 50000)
        throw new HttpError(
          400,
          'training_limit',
          'Training is limited to 50,000 observations per series in this scaffold.',
        );
      const snapshot = rows.rows.map((row) => ({
        timestamp: row.timestamp.toISOString(),
        value: row.value,
      }));
      const result = await client.query(
        `INSERT INTO training_jobs (id, tenant_id, series_id, run_id, status, config, observation_snapshot, max_attempts) VALUES ($1,$2,$3,$4,'queued',$5::jsonb,$6::jsonb,$7) RETURNING id, status`,
        [
          randomUUID(),
          tenantId,
          seriesId,
          randomUUID(),
          JSON.stringify(config),
          JSON.stringify(snapshot),
          maxAttempts,
        ],
      );
      return result.rows[0];
    });
  } catch (error) {
    if (error.code === '23505')
      throw new HttpError(
        409,
        'training_active',
        'This series already has a queued or running training job.',
      );
    throw error;
  }
}

export function runWithFreshness(result, current) {
  return {
    ...result,
    stale:
      Number(current.observation_count) !== result.sample_count ||
      new Date(current.last_timestamp).getTime() !== new Date(result.data_cutoff).getTime(),
    latest_observation_timestamp: current.last_timestamp?.toISOString() ?? null,
    current_observation_count: Number(current.observation_count),
  };
}

export async function latestRun(pool, tenantId, seriesId) {
  await ownedSeries(pool, tenantId, seriesId);
  const result = await pool.query(
    'SELECT result FROM model_runs WHERE tenant_id = $1 AND series_id = $2 ORDER BY created_at DESC, id DESC LIMIT 1',
    [tenantId, seriesId],
  );
  if (!result.rowCount)
    throw new HttpError(404, 'no_model', 'No trained model is available for this series.');
  const current = await pool.query(
    'SELECT count(*) AS observation_count, max(timestamp) AS last_timestamp FROM observations WHERE tenant_id = $1 AND series_id = $2',
    [tenantId, seriesId],
  );
  return runWithFreshness(result.rows[0].result, current.rows[0]);
}
