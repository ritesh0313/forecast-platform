import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateModelResult } from '../src/model-client.js';

const result = JSON.parse(
  await readFile(new URL('../../../data/demo-result.json', import.meta.url), 'utf8'),
);
const job = {
  run_id: result.run_id,
  series_id: result.series_id,
  config: result.config,
  observation_snapshot: Array.from({ length: result.sample_count }, () => ({
    timestamp: result.data_cutoff,
    value: 0,
  })),
};

test('real Python result accepts per-horizon metrics and generated microsecond timestamps', () => {
  const accepted = validateModelResult(result, job);
  assert.equal(accepted.forecast.length, 7);
  assert.equal(accepted.metrics.by_horizon.length, 7);
  assert.match(accepted.trained_at, /Z$/);
});

test('model responses cannot publish mismatched provenance, nonfinite metrics or malformed intervals', () => {
  const wrongId = structuredClone(result);
  wrongId.run_id = '11111111-1111-4111-8111-111111111111';
  assert.throws(() => validateModelResult(wrongId, job), /provenance/);
  const wrongMetric = structuredClone(result);
  wrongMetric.metrics.by_horizon[0].mae = Infinity;
  assert.throws(() => validateModelResult(wrongMetric, job), /invalid result/);
  const wrongInterval = structuredClone(result);
  wrongInterval.forecast[0].lower = wrongInterval.forecast[0].upper + 1;
  assert.throws(() => validateModelResult(wrongInterval, job), /invalid prediction intervals/);
  const wrongDate = structuredClone(result);
  wrongDate.forecast[0].timestamp = result.data_cutoff;
  assert.throws(() => validateModelResult(wrongDate, job), /invalid forecast horizons/);
});
