// Real HTTP/DB/model smoke flow. Run against an already started local stack.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { SignJWT } from '../apps/api/node_modules/jose/dist/webapi/index.js';

const base = (process.env.API_BASE || 'http://127.0.0.1:3000').replace(/\/$/, '');
const secret = process.env.JWT_SECRET;
if (!secret || secret.length < 32) throw new Error('JWT_SECRET is required; run with the local .env loaded.');
const tenant = randomUUID();
const mint = (tenantId, role) => new SignJWT({ tenant_id: tenantId, role })
  .setProtectedHeader({ alg: 'HS256' }).setSubject('smoke-test')
  .setIssuer('forecast-platform').setAudience('forecast-api').setIssuedAt().setExpirationTime('10m')
  .sign(new TextEncoder().encode(secret));
const trainer = await mint(tenant, 'trainer');
const reader = await mint(tenant, 'reader');
const stranger = await mint(randomUUID(), 'trainer');
async function request(path, { method = 'GET', body, token = trainer, status = 200 } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
  return data;
}
await request('/health');
await request('/api/series', { token: null, status: 401 });
const created = await request('/api/series', { method: 'POST', body: { name: `Smoke ${Date.now()}`, frequency: 'D' }, status: 201 });
const id = created.series.id;
await request(`/api/series/${id}/observations`, { token: stranger, status: 404 });
await request(`/api/series/${id}/retrain`, { method: 'POST', token: reader, body: { config: {} }, status: 403 });
const csv = await readFile(new URL('../data/demo.csv', import.meta.url), 'utf8');
const observations = csv.trim().split(/\r?\n/).slice(1).map(line => {
  const [timestamp, value] = line.split(',');
  return { timestamp, value: Number(value) };
});
await request(`/api/series/${id}/observations`, { method: 'POST', body: { observations } });
await request(`/api/series/${id}/retrain`, { method: 'POST', body: { config: { horizon: 0 } }, status: 400 });
const enqueued = await request(`/api/series/${id}/retrain`, { method: 'POST', body: { config: { horizon: 7, epochs: 20, seed: 42 } }, status: 202 });
const deadline = Date.now() + 180000;
let job;
while (Date.now() < deadline) {
  job = (await request(`/api/jobs/${enqueued.job.id}`)).job;
  if (job.status === 'succeeded' || job.status === 'failed') break;
  await new Promise(resolve => setTimeout(resolve, 500));
}
assert.equal(job?.status, 'succeeded', JSON.stringify(job));
const { run } = await request(`/api/series/${id}/forecast`);
assert.equal(run.forecast.length, 7);
assert.equal(run.sample_count, observations.length);
assert.equal(run.run_id, job.run_id);
assert.ok(Number.isFinite(run.metrics.mae));
assert.ok(run.forecast.every(point => Number.isFinite(point.predicted) && point.lower <= point.predicted && point.upper >= point.predicted));
const metrics = await request(`/api/series/${id}/metrics`);
assert.equal(metrics.run_id, run.run_id);
await request(`/api/runs/${run.run_id}`, { token: stranger, status: 404 });
const future = new Date(observations.at(-1).timestamp);
future.setUTCDate(future.getUTCDate() + 1);
await request(`/api/series/${id}/observations`, { method: 'POST', body: { observations: [{ timestamp: future.toISOString(), value: 125 }] } });
const after = await request(`/api/series/${id}/forecast`);
assert.equal(after.run.run_id, run.run_id, 'Ingestion must not silently retrain or change the stored forecast.');
assert.equal(after.run.stale, true, 'New observations must mark the stored run stale.');
console.log(JSON.stringify({ verified: ['JWT authentication', 'trainer permissions', 'tenant isolation', 'ingestion', 'bounded config', 'durable retraining', 'Python train/infer', 'Postgres results', 'metrics', 'stable forecast after ingestion'], selected_model: run.selected_model, forecast_points: run.forecast.length, metrics: run.metrics }, null, 2));
