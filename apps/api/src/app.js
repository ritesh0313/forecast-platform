import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { authenticate, trainer } from './auth.js';
import { errorHandler, HttpError } from './errors.js';
import {
  parse,
  uuidSchema,
  seriesSchema,
  normalizedObservations,
  observationLimit,
  trainingConfig,
} from './validation.js';
import {
  ownedSeries,
  ingestObservations,
  enqueueTraining,
  latestRun,
  publicJobColumns,
} from './repository.js';

export function securityHeaders(localHttp = false) {
  return helmet({
    contentSecurityPolicy: {
      directives: {
        // Safari upgrades localhost assets to HTTPS when this directive is
        // present. Keep it enabled unless the operator explicitly opts into
        // a loopback-only HTTP deployment.
        'upgrade-insecure-requests': localHttp ? null : [],
      },
    },
    strictTransportSecurity: localHttp ? false : undefined,
  });
}

export function createApp({
  pool,
  jwtSecret,
  webDist,
  production = false,
  localHttp = false,
  maxAttempts = 3,
  rateLimiting = true,
}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders(localHttp));
  app.use(express.json({ limit: '2mb', strict: true }));
  // Readiness is public and checks the dependency needed to handle requests.
  app.get('/health', async (_request, response) => {
    try {
      await pool.query('SELECT 1');
      response.json({ status: 'ready' });
    } catch {
      response.status(503).json({ status: 'unavailable' });
    }
  });
  const api = express.Router();
  if (rateLimiting)
    api.use(
      rateLimit({
        windowMs: 60000,
        limit: 120,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        handler: (_req, res) =>
          res.status(429).json({
            error: { code: 'rate_limited', message: 'Too many requests. Try again shortly.' },
          }),
      }),
    );
  api.use(authenticate(jwtSecret));
  api.param('id', (request, _response, next, value) => {
    try {
      request.entityId = parse(uuidSchema, value);
      next();
    } catch (error) {
      next(error);
    }
  });
  api.get('/series', async (request, response) => {
    const result = await pool.query(
      `SELECT s.id, s.name, s.frequency, count(o.timestamp)::int AS observation_count, max(o.timestamp) AS last_timestamp FROM series s LEFT JOIN observations o ON o.tenant_id = s.tenant_id AND o.series_id = s.id WHERE s.tenant_id = $1 GROUP BY s.id ORDER BY s.created_at, s.id`,
      [request.auth.tenantId],
    );
    response.json({ series: result.rows });
  });
  api.post('/series', trainer, async (request, response) => {
    const body = parse(seriesSchema, request.body);
    const result = await pool.query(
      'INSERT INTO series (id, tenant_id, name, frequency) VALUES ($1,$2,$3,$4) RETURNING id, name, frequency',
      [randomUUID(), request.auth.tenantId, body.name, body.frequency],
    );
    response.status(201).json({ series: result.rows[0] });
  });
  api.get('/series/:id/observations', async (request, response) => {
    await ownedSeries(pool, request.auth.tenantId, request.entityId);
    const limit = observationLimit(request.query.limit);
    const result = await pool.query(
      `SELECT timestamp, value FROM (SELECT timestamp, value FROM observations WHERE tenant_id = $1 AND series_id = $2 ORDER BY timestamp DESC LIMIT $3) recent ORDER BY timestamp`,
      [request.auth.tenantId, request.entityId, limit],
    );
    response.json({ observations: result.rows });
  });
  api.post('/series/:id/observations', trainer, async (request, response) => {
    const observations = normalizedObservations(request.body);
    const inserted = await ingestObservations(
      pool,
      request.auth.tenantId,
      request.entityId,
      observations,
    );
    response.json({ inserted });
  });
  api.post('/series/:id/retrain', trainer, async (request, response) => {
    const job = await enqueueTraining(
      pool,
      request.auth.tenantId,
      request.entityId,
      (frequency) => trainingConfig(request.body ?? {}, frequency),
      maxAttempts,
    );
    response.status(202).json({ job });
  });
  api.get('/series/:id/jobs', async (request, response) => {
    await ownedSeries(pool, request.auth.tenantId, request.entityId);
    const result = await pool.query(
      `SELECT ${publicJobColumns} FROM training_jobs WHERE tenant_id = $1 AND series_id = $2 ORDER BY created_at DESC LIMIT 50`,
      [request.auth.tenantId, request.entityId],
    );
    response.json({ jobs: result.rows });
  });
  api.get('/jobs/:id', async (request, response) => {
    const result = await pool.query(
      `SELECT ${publicJobColumns} FROM training_jobs WHERE tenant_id = $1 AND id = $2`,
      [request.auth.tenantId, request.entityId],
    );
    if (!result.rowCount) throw new HttpError(404, 'not_found', 'Job not found.');
    response.json({ job: result.rows[0] });
  });
  api.get('/series/:id/runs', async (request, response) => {
    await ownedSeries(pool, request.auth.tenantId, request.entityId);
    const result = await pool.query(
      `SELECT id, selected_model, created_at, result->'metrics' AS metrics, data_cutoff FROM model_runs WHERE tenant_id = $1 AND series_id = $2 ORDER BY created_at DESC LIMIT 50`,
      [request.auth.tenantId, request.entityId],
    );
    response.json({ runs: result.rows });
  });
  api.get('/series/:id/forecast', async (request, response) =>
    response.json({ run: await latestRun(pool, request.auth.tenantId, request.entityId) }),
  );
  api.get('/series/:id/metrics', async (request, response) => {
    const run = await latestRun(pool, request.auth.tenantId, request.entityId);
    response.json({
      run_id: run.run_id,
      metrics: run.metrics,
      candidates: run.candidates,
      split: run.split,
    });
  });
  api.get('/runs/:id', async (request, response) => {
    const result = await pool.query(
      'SELECT result FROM model_runs WHERE tenant_id = $1 AND id = $2',
      [request.auth.tenantId, request.entityId],
    );
    if (!result.rowCount) throw new HttpError(404, 'not_found', 'Run not found.');
    response.json({ run: result.rows[0].result });
  });
  app.use('/api', api);
  app.use('/api', (_request, _response, next) =>
    next(new HttpError(404, 'not_found', 'Endpoint not found.')),
  );
  if (production && webDist) {
    const directory = path.resolve(webDist);
    app.use(express.static(directory));
    app.get('/{*path}', (_request, response) =>
      response.sendFile(path.join(directory, 'index.html')),
    );
  }
  app.use((_request, _response, next) =>
    next(new HttpError(404, 'not_found', 'Endpoint not found.')),
  );
  app.use(errorHandler);
  return app;
}
