import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { SignJWT } from 'jose';
import { createPool } from '../src/db.js';
import { createApp } from '../src/app.js';
import { claimJob, heartbeat, publishRun, failJob } from '../src/queue.js';

test(
  'Postgres tenancy, immutable snapshots, atomic ingestion and lease fencing',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = createPool(process.env.TEST_DATABASE_URL);
    const tenantId = randomUUID();
    const otherTenant = randomUUID();
    const secret = 'integration-test-only-secret-32-bytes-plus';
    await pool.query(
      await readFile(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8'),
    );
    const app = createApp({ pool, jwtSecret: secret, rateLimiting: false });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    async function sign(tenant, role = 'trainer') {
      return new SignJWT({ tenant_id: tenant, role })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer('forecast-platform')
        .setAudience('forecast-api')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(new TextEncoder().encode(secret));
    }
    const access = await sign(tenantId);
    const foreign = await sign(otherTenant);
    const reader = await sign(tenantId, 'reader');
    async function request(route, method = 'GET', body, token = access) {
      const response = await fetch(base + route, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    }
    try {
      assert.equal((await request('/health', 'GET', undefined, null)).status, 200);
      assert.equal((await request('/api/series', 'GET', undefined, null)).status, 401);
      assert.equal(
        (await request('/api/series', 'POST', { name: 'Blocked', frequency: 'D' }, reader)).status,
        403,
      );
      const created = await request('/api/series', 'POST', {
        name: 'Integration series',
        frequency: 'D',
      });
      assert.equal(created.status, 201);
      const id = created.body.series.id;
      const route = `/api/series/${id}`;
      assert.equal((await request(`${route}/observations`, 'GET', undefined, foreign)).status, 404);
      assert.equal((await request('/api/series', 'GET', undefined, foreign)).body.series.length, 0);
      const initial = {
        observations: [
          { timestamp: '2025-01-01T00:00:00Z', value: 10 },
          { timestamp: '2025-01-02T00:00:00Z', value: 11 },
        ],
      };
      assert.equal((await request(`${route}/observations`, 'POST', initial)).body.inserted, 2);
      assert.equal((await request(`${route}/observations`, 'POST', initial)).body.inserted, 0);
      assert.equal(
        (
          await request(`${route}/observations`, 'POST', {
            observations: [
              { timestamp: '2025-01-02T00:00:00Z', value: 999 },
              { timestamp: '2025-01-03T00:00:00Z', value: 12 },
            ],
          })
        ).status,
        409,
      );
      assert.equal((await request(`${route}/observations`)).body.observations.length, 2);
      assert.equal(
        (
          await request(`${route}/observations`, 'POST', {
            observations: [{ timestamp: '2025-01-04T00:00:00Z', value: 13 }],
          })
        ).status,
        400,
      );
      assert.equal((await request(`${route}/retrain`, 'POST', { config: {} }, reader)).status, 403);
      const enqueued = await request(`${route}/retrain`, 'POST', { config: { horizon: 1 } });
      assert.equal(enqueued.status, 202);
      const jobId = enqueued.body.job.id;
      assert.equal((await request(`${route}/retrain`, 'POST', { config: {} })).status, 409);
      assert.equal((await request(`/api/jobs/${jobId}`, 'GET', undefined, foreign)).status, 404);
      assert.equal(
        (
          await request(`${route}/observations`, 'POST', {
            observations: [{ timestamp: '2025-01-03T00:00:00Z', value: 12 }],
          })
        ).body.inserted,
        1,
      );
      const old = await claimJob(pool, 90);
      assert.equal(old.id, jobId);
      assert.equal(old.observation_snapshot.length, 2);
      assert.equal(await claimJob(pool, 90), null);
      await pool.query(
        "UPDATE training_jobs SET lease_until = now() - interval '1 second' WHERE id = $1 AND tenant_id = $2",
        [jobId, tenantId],
      );
      const current = await claimJob(pool, 90);
      assert.equal(current.attempts, 2);
      assert.notEqual(current.lease_token, old.lease_token);
      assert.equal(await heartbeat(pool, old, 90), false);
      const result = {
        run_id: current.run_id,
        series_id: id,
        selected_model: 'naive',
        sample_count: 2,
        data_cutoff: '2025-01-02T00:00:00.000Z',
        metrics: { mae: 1 },
        candidates: [],
        split: {},
        forecast: [],
      };
      assert.equal(await publishRun(pool, old, result), false);
      assert.equal(await publishRun(pool, current, result), true);
      assert.equal(await publishRun(pool, current, result), false);
      assert.equal((await request(`/api/jobs/${jobId}`)).body.job.status, 'succeeded');
      const forecast = await request(`${route}/forecast`);
      assert.equal(forecast.body.run.stale, true);
      assert.equal(forecast.body.run.current_observation_count, 3);
      assert.equal(
        (await request(`/api/runs/${current.run_id}`, 'GET', undefined, foreign)).status,
        404,
      );
      assert.equal((await request(`${route}/metrics`)).body.run_id, current.run_id);
      assert.equal((await request(`${route}/runs`)).body.runs.length, 1);
      const retryJob = await request(`${route}/retrain`, 'POST', { config: {} });
      const retryClaim = await claimJob(pool, 90);
      assert.equal(retryClaim.id, retryJob.body.job.id);
      assert.equal(
        await failJob(pool, retryClaim, 'Transient integration test failure.', true),
        true,
      );
      assert.equal((await request(`/api/jobs/${retryClaim.id}`)).body.job.status, 'queued');
      await pool.query(
        'UPDATE training_jobs SET available_at = now(), max_attempts = 2 WHERE tenant_id = $1 AND id = $2',
        [tenantId, retryClaim.id],
      );
      const lastClaim = await claimJob(pool, 90);
      assert.equal(lastClaim.attempts, 2);
      await pool.query(
        "UPDATE training_jobs SET lease_until = now() - interval '1 second' WHERE tenant_id = $1 AND id = $2",
        [tenantId, lastClaim.id],
      );
      assert.equal(await claimJob(pool, 90), null);
      assert.equal((await request(`/api/jobs/${lastClaim.id}`)).body.job.status, 'failed');
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await pool.query('DELETE FROM model_runs WHERE tenant_id = $1', [tenantId]);
      await pool.query('DELETE FROM training_jobs WHERE tenant_id = $1', [tenantId]);
      await pool.query('DELETE FROM observations WHERE tenant_id = $1', [tenantId]);
      await pool.query('DELETE FROM series WHERE tenant_id = $1', [tenantId]);
      await pool.end();
    }
  },
);
