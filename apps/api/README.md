# Forecast API and durable worker

Express 5 REST API with Postgres storage. Run `npm ci` in this directory. Node 22 or newer is required. See the project README for the complete Docker setup.

## Configuration

`DATABASE_URL` and `JWT_SECRET` are required. Use an independently generated random secret of at least 32 bytes. No development fallback secret is provided. Server defaults to `PORT=3000`; set `NODE_ENV=production` and `WEB_DIST=/app/apps/web/dist` to serve the built dashboard on the same origin. `LOCAL_HTTP=true` is reserved for the supplied loopback-only development binding; it removes only the HTTPS upgrade and HSTS headers that can make Safari treat local assets as HTTPS. Leave it false behind TLS.

The separate worker requires `MODEL_SERVICE_TOKEN` (independent random secret, at least 32 bytes) and uses `MODEL_SERVICE_URL=http://127.0.0.1:8000`. Optional controls: `JOB_LEASE_SECONDS=90`, `WORKER_POLL_MS=2000`, `MODEL_TIMEOUT_MS=900000`, and `JOB_MAX_ATTEMPTS=3`. The model service token must match the Python service environment.

`npm run migrate` applies the idempotent initial schema inside a transaction and advisory lock. `npm run seed` imports the synthetic `data/demo.csv`; the demo tenant is `11111111-1111-4111-8111-111111111111`, overridable with `DEMO_TENANT_ID`, and the demo series is `22222222-2222-4222-8222-222222222222`. `npm run token -- <tenant_uuid> <reader|trainer>` creates a one-hour local development token using `JWT_SECRET`. This helper is a local development tool: production should issue short-lived tokens through the platform's identity provider with verified tenant membership. `npm start` starts the server; `npm run worker` starts the worker; `npm run dev` enables server watch mode.

## REST contract

All `/api` endpoints require a Bearer HS256 JWT with issuer `forecast-platform`, audience `forecast-api`, UUID `tenant_id`, `role` equal to `reader` or `trainer`, and `exp`/`iat`. Tokens are limited to a 24-hour age. Writes require `trainer`. `/health` is public and returns 503 when Postgres is unavailable. Same-origin hosting is the default; development uses the dashboard's API proxy.

| Route | Purpose |
| --- | --- |
| `GET /api/series` | Tenant-owned series with observation counts and latest timestamps |
| `POST /api/series` | Create `{name,frequency:"D"\|"h"}` |
| `GET /api/series/:id/observations?limit=500` | Most recent observations in ascending timestamp order; max 10,000 |
| `POST /api/series/:id/observations` | Atomically ingest `{observations:[{timestamp,value}]}` |
| `POST /api/series/:id/retrain` | Queue immutable snapshot with `{config:{...}}`; returns 202 |
| `GET /api/series/:id/jobs` | Latest 50 jobs |
| `GET /api/jobs/:id` | Current job status and safe error message |
| `GET /api/series/:id/runs` | Latest 50 model runs |
| `GET /api/series/:id/forecast` | Latest full model result with `stale`, `data_cutoff`, `latest_observation_timestamp`, and `current_observation_count` |
| `GET /api/series/:id/metrics` | Selected metrics, model comparisons and split metadata |
| `GET /api/runs/:id` | Immutable historical run result |

Timestamp input must be a real UTC ISO date-time ending in `Z`, with at most three fractional digits. Values must be finite JSON numbers in the range -1e12 to 1e12. Each request accepts at most 10,000 observations and 2 MB of JSON. Input duplicates with identical values are idempotent; conflicting values return 409 and roll back the entire batch. Stored observations are immutable. Corrections require a new series. The complete series must remain regularly spaced without missing timestamps at its daily or hourly cadence; choose an explicit imputation/resampling policy before import for irregular user data.

Training snapshots contain at most 50,000 observations. Supported bounded configuration keys are `horizon`, `frequency`, `season_length`, `lags`, `epochs`, `seed`, `train_fraction`, `validation_fraction`, and `interval_alpha`. Frequency must match the series. Defaults match `docs/CONTRACT.md`; hourly defaults use horizon 24, season length 24, and lags 48. The Python service verifies the minimum number of train/tune/calibration/test windows. Its 422 errors become a failed job with a safe message. Retraining requests while that series has an active job return 409.

## Reliability and security

Ingestion and enqueue lock the tenant-owned series row. Enqueue copies observations and configuration into Postgres, so later uploads cannot change a running experiment. Workers claim jobs with `FOR UPDATE SKIP LOCKED`. An expiring heartbeat lease includes a unique fencing token. A stale worker cannot heartbeat, complete, fail, or publish a job reclaimed by another worker. Publication inserts one immutable run and marks the job succeeded in the same transaction. A unique active-job index and unique job-to-run mapping guard concurrency. Transient network/server failures retry with a bounded exponential delay; permanent model validation failures stop immediately. Expired final-attempt jobs become failed. The Python service makes repeated requests for the same run ID idempotent.

Every public data query is parameterized and scoped to the authenticated tenant. Cross-tenant IDs return 404. The internal worker is a trusted service with queue-wide access; deploy the DB and model service on a private network. Helmet, request limits and an IP rate limiter provide basic HTTP protections. The bundled rate limiter is process-local; use a shared gateway or shared store when scaling API replicas. Supply HTTPS and the platform's identity provider for production. The schema does not enable Postgres row-level security; tenant protection is enforced in API queries and composite foreign keys. Database credential privileges, backups, monitoring, and secret rotation are deployment responsibilities.

## Tests

`npm test` runs validation, JWT policy and real Python-result compatibility tests. Set `TEST_DATABASE_URL` to an **isolated test database** to also run the Postgres/HTTP integration test. It applies the schema and cleans up only its random tenant, but workers sharing the same test database must be stopped because the queue test intentionally claims available jobs. Integration coverage includes tenant isolation, role checks, transaction rollback, cadence, immutable snapshots, active-job deduplication, lease reclamation, fencing, retry exhaustion, single publication and staleness.
