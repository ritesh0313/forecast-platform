import { z } from 'zod';
import { HttpError } from './errors.js';

export const uuidSchema = z.uuid();
const utcPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
export function isUtcTimestamp(value) {
  if (typeof value !== 'string' || !utcPattern.test(value)) return false;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return false;
  const canonical = value.includes('.')
    ? value.replace(/\.(\d+)Z$/, (_, digits) => `.${digits.padEnd(3, '0')}Z`)
    : value.replace(/Z$/, '.000Z');
  return parsed.toISOString() === canonical;
}

export const observationsSchema = z
  .object({
    observations: z
      .array(
        z
          .object({
            timestamp: z
              .string()
              .refine(isUtcTimestamp, 'Use a valid UTC ISO timestamp ending in Z.'),
            value: z.number().finite().min(-1e12).max(1e12),
          })
          .strict(),
      )
      .min(1)
      .max(10000),
  })
  .strict();

export const seriesSchema = z
  .object({ name: z.string().trim().min(1).max(120), frequency: z.enum(['D', 'h']) })
  .strict();
export const retrainSchema = z
  .object({
    config: z
      .object({
        horizon: z.number().int().min(1).max(90).optional(),
        frequency: z.enum(['D', 'h']).optional(),
        season_length: z.number().int().min(1).max(168).optional(),
        lags: z.number().int().min(2).max(336).optional(),
        epochs: z.number().int().min(1).max(500).optional(),
        seed: z.number().int().min(0).max(2147483647).optional(),
        train_fraction: z.number().min(0.4).max(0.8).optional(),
        validation_fraction: z.number().min(0.1).max(0.4).optional(),
        interval_alpha: z.number().min(0.01).max(0.5).optional(),
      })
      .strict()
      .default({}),
  })
  .strict();

export function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new HttpError(
      400,
      'validation_error',
      result.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`)
        .join('; '),
    );
  return result.data;
}

export function normalizedObservations(body) {
  const values = parse(observationsSchema, body).observations;
  const byTimestamp = new Map();
  for (const observation of values) {
    const timestamp = new Date(observation.timestamp).toISOString();
    if (byTimestamp.has(timestamp) && byTimestamp.get(timestamp) !== observation.value)
      throw new HttpError(
        409,
        'conflicting_observation',
        'A timestamp has multiple conflicting values.',
      );
    byTimestamp.set(timestamp, observation.value);
  }
  return [...byTimestamp]
    .map(([timestamp, value]) => ({ timestamp, value }))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export function trainingConfig(body, frequency) {
  const supplied = parse(retrainSchema, body).config;
  if (supplied.frequency && supplied.frequency !== frequency)
    throw new HttpError(400, 'frequency_mismatch', 'Training frequency must match the series.');
  const config = {
    horizon: frequency === 'h' ? 24 : 7,
    frequency,
    season_length: frequency === 'h' ? 24 : 7,
    lags: frequency === 'h' ? 48 : 28,
    epochs: 80,
    seed: 42,
    train_fraction: 0.6,
    validation_fraction: 0.25,
    interval_alpha: 0.1,
    ...supplied,
  };
  if (config.train_fraction + config.validation_fraction > 0.95)
    throw new HttpError(
      400,
      'invalid_split',
      'Training and validation fractions must leave at least 5% for test.',
    );
  return config;
}

export function observationLimit(value) {
  if (value === undefined) return 500;
  if (typeof value !== 'string' || !/^\d+$/.test(value))
    throw new HttpError(400, 'validation_error', 'limit must be an integer from 1 to 10000.');
  const parsed = Number(value);
  if (parsed < 1 || parsed > 10000)
    throw new HttpError(400, 'validation_error', 'limit must be an integer from 1 to 10000.');
  return parsed;
}
