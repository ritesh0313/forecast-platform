export function requireSecret(value, name) {
  if (typeof value !== 'string' || Buffer.byteLength(value) < 32) {
    throw new Error(`${name} must contain at least 32 bytes. Generate a unique random secret.`);
  }
  return value;
}

function integer(value, fallback, min, max, name) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    throw new Error(`Invalid ${name}.`);
  return parsed;
}

function boolean(value, fallback, name) {
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Invalid ${name}. Expected "true" or "false".`);
}

export function loadConfig(environment = process.env, { worker = false } = {}) {
  if (!environment.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const config = {
    databaseUrl: environment.DATABASE_URL,
    port: integer(environment.PORT, 3000, 1, 65535, 'PORT'),
    jwtSecret: requireSecret(environment.JWT_SECRET, 'JWT_SECRET'),
    webDist: environment.WEB_DIST,
    production: environment.NODE_ENV === 'production',
    // This is deliberately independent of NODE_ENV: the production build can
    // still be served over plain HTTP on a loopback-only development binding.
    localHttp: boolean(environment.LOCAL_HTTP, false, 'LOCAL_HTTP'),
    leaseSeconds: integer(environment.JOB_LEASE_SECONDS, 90, 15, 3600, 'JOB_LEASE_SECONDS'),
    pollMs: integer(environment.WORKER_POLL_MS, 2000, 100, 60000, 'WORKER_POLL_MS'),
    requestTimeoutMs: integer(
      environment.MODEL_TIMEOUT_MS,
      900000,
      1000,
      3600000,
      'MODEL_TIMEOUT_MS',
    ),
    maxAttempts: integer(environment.JOB_MAX_ATTEMPTS, 3, 1, 5, 'JOB_MAX_ATTEMPTS'),
  };
  if (worker) {
    config.serviceToken = requireSecret(environment.MODEL_SERVICE_TOKEN, 'MODEL_SERVICE_TOKEN');
    const url = new URL(environment.MODEL_SERVICE_URL || 'http://127.0.0.1:8000');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error('Invalid MODEL_SERVICE_URL.');
    config.modelUrl = url.href.replace(/\/$/, '');
  }
  return config;
}
