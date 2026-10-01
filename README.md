# Forecast Studio

A modular forecasting system with a reproducible Python workflow, authenticated Node REST API, durable Postgres retraining queue, and React dashboard.

**No historical dataset or existing application was supplied.** This is a clean scaffold with a reproducible synthetic daily-demand example. The demonstration metrics describe that example only. Integration with your existing repository and business-data validation remain separate milestones.

## What is implemented

- Strict UTC daily/hourly input validation and a CSV inspection command; one univariate series per run.
- Past-only lag, rolling-statistic and known-calendar features; direct multi-horizon supervised targets.
- Chronological train, tuning, interval-calibration and final test blocks, with crossing target windows purged and train-only scaling.
- Last-value and seasonal baselines, ridge regression, and a deterministic CPU PyTorch multilayer network. Tuning selects the model; final test data does not select it.
- MAE, RMSE, sMAPE, MASE and per-horizon errors; empirical prediction intervals with held-out coverage and width. Undefined MASE returns JSON null; sMAPE handles zero values.
- Recorded configuration, seed, data hash, versions, split boundaries, selected-model weights/scalers, atomic artifacts, reloadable inference and idempotent training runs.
- Signed JWT authentication, trainer/reader permissions, tenant-scoped SQL, bounded JSON inputs, security headers and rate limits.
- Immutable retraining snapshots, leased/fenced Postgres jobs, bounded retries and stored forecasts/metrics.
- Responsive dashboard with forecast intervals, historical observations, actual-versus-predicted results, candidate comparison, data freshness, series creation, CSV/JSON ingestion and background retraining status.
- Dependency lockfiles, meaningful unit/integration tests, end-to-end smoke script and CI.

## Run the full stack

Requirements: Docker with Compose, plus Node 22.12+ for the local setup helper. Containers use Node 22, Python 3.12 and Postgres 18. Container tags track their supported branches; pin reviewed image digests in a production release.

```sh
npm run setup
docker compose up --build -d
docker compose exec api npm --prefix apps/api run seed
docker compose exec api npm --silent --prefix apps/api run token
```

Open **http://localhost:3000**. The dashboard initially provides an explicit, read-only synthetic demo. Paste the token printed by the last command into the connection control to use the live API. The seed command imports the example into the local demo tenant; select that series and request training. The worker stores the resulting model and forecast. Re-ingesting observations does not change a trained forecast until a new run succeeds.

The setup helper creates unique random secrets in a permission-restricted `.env` and never overwrites it. Never commit `.env`. The token helper is a local development tool; use your existing identity provider for real users. Do not share tokens or expose the internal Python service. The compose stack publishes only the API on localhost. It does not deploy externally.

Stop with `docker compose down`. Named volumes preserve data and models. Back up those volumes before intentional removal.

## Use your data

Import a continuous, sorted series with this exact schema:

```csv
timestamp,value
2025-01-01T00:00:00Z,121.5
2025-01-02T00:00:00Z,124.1
```

Choose daily (`D`, exactly 24 hours in UTC) or hourly (`h`, exactly one hour). Convert local timestamps and decide aggregation/imputation policy before import. The pipeline rejects missing timestamps, duplicates, nonfinite targets and irregular cadence. Negative targets are valid; forecasts are not automatically clipped. Each import accepts up to 10,000 observations and a model run accepts up to 50,000. Use several contiguous imports for longer history. Existing observations are immutable; conflicting corrections require a new series.

For standalone training and artifact reload, see [Python workflow](services/model/README.md) and [example configuration](data/config.json). For authenticated endpoint examples and local token flags, see [API guide](apps/api/README.md). See [dashboard guide](apps/web/README.md) for development mode.

## Repository map

```text
services/model/    Data contract, features, splits, models, metrics, persistence, CLI, private HTTP service
apps/api/          Authentication, validation, routes, SQL migration, durable worker, local tools and tests
apps/web/          Typed client, data hook, responsive dashboard, SVG charts and import parsing
scripts/           Unique-secret setup and real HTTP end-to-end smoke flow
data/             Synthetic CSV, example experiment config and generated demonstration result
docs/             Architecture, endpoint contract, verification record and integration milestones
.github/workflows/ CI for Python, Node, React, Postgres and a full retraining flow
```

## Verify locally

```sh
npm --prefix apps/api ci
npm --prefix apps/web ci
npm run test:api
npm run test:web
npm run build:web
python3.12 -m venv .venv
.venv/bin/pip install -r services/model/requirements-dev.txt
cd services/model
../../.venv/bin/python -m pytest -q
```

Set `TEST_DATABASE_URL` to an isolated Postgres test database to enable API integration tests. Database tests create scoped fixtures, so use a disposable database. The standalone end-to-end smoke script expects the model service, API and worker already running; provide `JWT_SECRET` and optionally `API_BASE`, then run `npm run smoke`. In Compose, run it inside the API container with `docker compose exec api node scripts/smoke.mjs`. The smoke run imports an isolated tenant fixture and creates a real training job; use a development database. See [verification record](docs/VERIFICATION.md) for exactly what was run and limitations.

## Integration and iteration

The REST API contract is [documented here](docs/CONTRACT.md). Mount its handlers in your backend, apply the migration in your Postgres schema, map authentication to your identity provider, and reuse the React components. Keep the Python service and worker separate from web request handling. See [architecture and operational notes](docs/ARCHITECTURE.md) for evaluation interpretation, tenant isolation, job lifecycle, freshness and production requirements.

The recommended part-time plan is in [milestones](docs/MILESTONES.md): data mapping and business contract; benchmark on real history; existing-platform integration; operational launch; weekly error/drift review. The system does not claim production readiness or business accuracy from synthetic data, and it does not automatically enforce a business quality gate when promoting the latest successful run.
