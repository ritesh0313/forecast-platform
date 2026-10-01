import { randomUUID } from 'node:crypto';
import { transaction } from './db.js';

// Workers have cross-tenant queue access, but every operation after claim is scoped
// to the claimed tenant and guarded by an unguessable lease token.
export async function claimJob(pool, leaseSeconds) {
  return transaction(pool, async (client) => {
    await client.query(
      `UPDATE training_jobs SET status = 'failed', completed_at = now(), error = 'Worker lease expired after the maximum number of attempts.', lease_token = NULL, lease_until = NULL WHERE status = 'running' AND lease_until <= now() AND attempts >= max_attempts`,
    );
    const candidate = await client.query(
      `SELECT id, tenant_id FROM training_jobs WHERE (status = 'queued' AND available_at <= now() OR status = 'running' AND lease_until <= now()) AND attempts < max_attempts ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
    );
    if (!candidate.rowCount) return null;
    const row = candidate.rows[0];
    const result = await client.query(
      `UPDATE training_jobs SET status = 'running', started_at = coalesce(started_at, now()), completed_at = NULL, error = NULL, attempts = attempts + 1, lease_token = $3, lease_until = now() + ($4 * interval '1 second'), heartbeat_at = now() WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [row.id, row.tenant_id, randomUUID(), leaseSeconds],
    );
    return result.rows[0];
  });
}

export async function heartbeat(pool, job, leaseSeconds) {
  const result = await pool.query(
    `UPDATE training_jobs SET lease_until = now() + ($4 * interval '1 second'), heartbeat_at = now() WHERE id = $1 AND tenant_id = $2 AND lease_token = $3 AND status = 'running' AND lease_until > now()`,
    [job.id, job.tenant_id, job.lease_token, leaseSeconds],
  );
  return result.rowCount === 1;
}

export async function publishRun(pool, job, result) {
  return transaction(pool, async (client) => {
    // Lock and verify ownership before publishing. A stale worker cannot publish
    // even when its HTTP result arrives after another worker has reclaimed the job.
    const updated = await client.query(
      `UPDATE training_jobs SET status = 'succeeded', completed_at = now(), error = NULL, lease_until = NULL, lease_token = NULL WHERE id = $1 AND tenant_id = $2 AND lease_token = $3 AND status = 'running' AND lease_until > now() RETURNING id`,
      [job.id, job.tenant_id, job.lease_token],
    );
    if (!updated.rowCount) return false;
    await client.query(
      `INSERT INTO model_runs (id, tenant_id, series_id, job_id, selected_model, data_cutoff, result) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [
        job.run_id,
        job.tenant_id,
        job.series_id,
        job.id,
        result.selected_model,
        result.data_cutoff,
        JSON.stringify(result),
      ],
    );
    return true;
  });
}

export async function failJob(pool, job, message, retryable) {
  const result = await pool.query(
    `UPDATE training_jobs SET status = CASE WHEN $5::boolean AND attempts < max_attempts THEN 'queued' ELSE 'failed' END, completed_at = CASE WHEN $5::boolean AND attempts < max_attempts THEN NULL ELSE now() END, error = $4, lease_until = NULL, lease_token = NULL, available_at = now() + (least(60, power(2, attempts)) * interval '1 second') WHERE id = $1 AND tenant_id = $2 AND lease_token = $3 AND status = 'running' AND lease_until > now()`,
    [job.id, job.tenant_id, job.lease_token, message, retryable],
  );
  return result.rowCount === 1;
}
