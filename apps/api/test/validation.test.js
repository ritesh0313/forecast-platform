import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isUtcTimestamp,
  normalizedObservations,
  trainingConfig,
  observationLimit,
} from '../src/validation.js';
import { runWithFreshness } from '../src/repository.js';
import { requireSecret } from '../src/config.js';

test('timestamps require real UTC dates rather than parseable local dates', () => {
  for (const value of [
    '2025-02-30T00:00:00Z',
    '2025-01-01',
    '2025-01-01T00:00:00+00:00',
    '2025-01-01T25:00:00Z',
  ])
    assert.equal(isUtcTimestamp(value), false);
  assert.equal(isUtcTimestamp('2025-01-01T00:00:00Z'), true);
  assert.equal(isUtcTimestamp('2025-01-01T00:00:00.2Z'), true);
});

test('ingestion is bounded, finite, canonicalized and rejects conflicting duplicates', () => {
  assert.deepEqual(
    normalizedObservations({
      observations: [
        { timestamp: '2025-01-01T00:00:00Z', value: 2 },
        { timestamp: '2025-01-01T00:00:00.000Z', value: 2 },
      ],
    }),
    [{ timestamp: '2025-01-01T00:00:00.000Z', value: 2 }],
  );
  assert.throws(
    () =>
      normalizedObservations({
        observations: [{ timestamp: '2025-01-01T00:00:00Z', value: Infinity }],
      }),
    /finite|number/i,
  );
  assert.throws(
    () =>
      normalizedObservations({
        observations: [{ timestamp: '2025-01-01T00:00:00Z', value: 1e13 }],
      }),
    /1000000000000/,
  );
  assert.throws(
    () =>
      normalizedObservations({
        observations: [
          { timestamp: '2025-01-01T00:00:00Z', value: 2 },
          { timestamp: '2025-01-01T00:00:00Z', value: 3 },
        ],
      }),
    /conflicting/,
  );
  assert.throws(
    () =>
      normalizedObservations({
        observations: Array.from({ length: 10001 }, () => ({
          timestamp: '2025-01-01T00:00:00Z',
          value: 2,
        })),
      }),
    /10000/,
  );
});

test('experiment overrides reject unknown fields, split leakage and frequency mismatch', () => {
  assert.equal(trainingConfig({ config: {} }, 'h').frequency, 'h');
  assert.equal(trainingConfig({ config: {} }, 'h').season_length, 24);
  assert.throws(() => trainingConfig({ config: { shell: 'anything' } }, 'D'), /Unrecognized/);
  assert.throws(
    () => trainingConfig({ config: { train_fraction: 0.8, validation_fraction: 0.3 } }, 'D'),
    /leave at least/,
  );
  assert.throws(() => trainingConfig({ config: { frequency: 'h' } }, 'D'), /must match/);
  assert.throws(() => trainingConfig({ config: { epochs: 501 } }, 'D'), /500/);
  assert.throws(() => observationLimit('2.5'), /integer/);
  assert.throws(() => requireSecret('short', 'JWT_SECRET'), /32 bytes/);
});

test('forecasts expose the immutable data cutoff and stale status', () => {
  const result = { data_cutoff: '2025-01-01T00:00:00.000Z', sample_count: 2 };
  assert.equal(
    runWithFreshness(result, {
      last_timestamp: new Date(result.data_cutoff),
      observation_count: '2',
    }).stale,
    false,
  );
  assert.equal(
    runWithFreshness(result, {
      last_timestamp: new Date(result.data_cutoff),
      observation_count: '3',
    }).stale,
    true,
  );
});
