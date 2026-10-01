import test from 'node:test';
import assert from 'node:assert/strict';
import { parseObservations, validateCadence, formatMetric } from './observations.ts';

test('normalizes timezone timestamps and sorts chronological CSV', () => {
  assert.deepEqual(
    parseObservations('timestamp,value\n2025-01-02T05:30:00+05:30,12\n2025-01-01T00:00:00Z,11'),
    [
      { timestamp: '2025-01-01T00:00:00.000Z', value: 11 },
      { timestamp: '2025-01-02T00:00:00.000Z', value: 12 },
    ],
  );
});
test('rejects impossible dates, nonnumeric JSON values, duplicate UTC timestamps and timezone-free dates', () => {
  for (const source of [
    '[{"timestamp":"2025-02-30T00:00:00Z","value":1}]',
    '[{"timestamp":"2025-01-01T00:00:00Z","value":"1"}]',
    'timestamp,value\n2025-01-01T00:00:00Z,1\n2025-01-01T01:00:00+01:00,2',
    'timestamp,value\n2025-01-01,1',
  ])
    assert.throws(() => parseObservations(source));
});
test('rejects training cadence gaps and renders undefined metrics without inventing zero', () => {
  assert.throws(() =>
    validateCadence(
      parseObservations('timestamp,value\n2025-01-01T00:00:00Z,1\n2025-01-03T00:00:00Z,2'),
      'D',
    ),
  );
  assert.equal(formatMetric(null), '—');
  assert.equal(formatMetric(0), '0');
});
