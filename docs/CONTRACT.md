# Integration contract

Single regularly spaced univariate series per training run. UTC ISO timestamps, finite numeric values. Demo is synthetic daily demand. Internal model service POST /train requires X-Service-Token. Input: {run_id: UUID, series_id: UUID, observations:[{timestamp: ISO,value: number}], config:{horizon:7, frequency:"D", season_length:7, lags:28, epochs:80, seed:42, train_fraction:0.6, validation_fraction:0.25, interval_alpha:0.1}}. Python may add optional config defaults. API accepts bounded supported config keys; daily or hourly frequencies D/h. Response saved as runs.result JSONB:

```json
{
 "run_id":"uuid", "series_id":"uuid", "selected_model":"ridge", "trained_at":"ISO", "data_cutoff":"ISO", "data_hash":"sha256", "sample_count":730,
 "config":{}, "split":{}, "metrics":{"mae":1,"rmse":1,"smape":1,"mase":1,"interval_coverage":0.9,"interval_mean_width":4},
 "candidates":[{"name":"naive","validation_mae":1,"test_metrics":{"mae":1,"rmse":1,"smape":1,"mase":1}}],
 "forecast":[{"timestamp":"ISO","horizon":1,"predicted":20,"lower":18,"upper":22}],
 "backtest":[{"timestamp":"ISO","horizon":1,"actual":20,"predicted":19,"lower":17,"upper":21}],
 "history":[{"timestamp":"ISO","value":20}], "warnings":[], "artifact_path":"server-relative run id"
}
```

Selected metrics are rolling-origin held-out test metrics; selection uses tuning validation only. Calibration uses a later disjoint part of validation. Persist artifacts for selected model; keep bounded history/backtest in HTTP result. All test_metrics exclude tune/calibration. Any missing undefined metric is null, never NaN. Model weights returned only in local artifacts, never JSON API.

Public Node API all except /health requires Authorization: Bearer JWT, HS256 JWT tenant_id claim UUID; roles reader/trainer, issuer forecast-platform, audience forecast-api. Tenant isolated database queries. Routes:
- GET /api/series -> {series:[{id,name,frequency,observation_count,last_timestamp}]}
- POST /api/series {name,frequency:"D"|"h"} -> 201 {series:{id,name,frequency}} (trainer)
- GET /api/series/:id/observations?limit=500 -> {observations:[{timestamp,value}]}
- POST /api/series/:id/observations {observations:[{timestamp,value}]} -> {inserted:number} (trainer; reject duplicate conflicting timestamps, validate cadence in training too)
- POST /api/series/:id/retrain {config:{...}} -> 202 {job:{id,status:"queued"}} (trainer)
- GET /api/series/:id/jobs -> {jobs:[{id,status,created_at,started_at,completed_at,error,run_id}]}
- GET /api/jobs/:id -> {job:...}
- GET /api/series/:id/runs -> {runs:[{id,selected_model,created_at,metrics,data_cutoff}]}
- GET /api/series/:id/forecast -> {run: full Python result} (404 if no model)
- GET /api/series/:id/metrics -> {run_id,metrics,candidates,split}
- GET /api/runs/:id -> {run:full Python result}
JSON errors {error:{code,message}}; worker stores immutable observations snapshot at enqueue. Tenant+series job deduplication; durable queue via Postgres SKIP LOCKED; lease heartbeat/fencing to prevent stale publish. Fresh data does not change trained forecasts until retraining. Node role checks on every write. Never spawn shell commands on user input.

React UI API client follows this contract; token in memory, controls for series selection, adding JSON/CSV observations and training, poll jobs while active, historical/forecast interval chart, one-step actual-vs-predicted, selected metrics/model comparison, provenance/synthetic-demo badge. Optional demo mode uses a bundled real Python result, clearly labeled and never executes writes.
