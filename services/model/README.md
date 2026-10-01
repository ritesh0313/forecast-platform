# Forecasting model service

This implements supervised direct forecasting for one regularly spaced numerical series per run. The bundled data are **synthetic demand**, generated for integration testing. No accuracy claim applies to the user's historical data until that data have been connected and evaluated.

From the repository root, with Python 3.12:

```sh
python3.12 -m venv .venv
.venv/bin/pip install -r services/model/requirements-dev.txt
export PYTHONPATH=services/model
.venv/bin/python -m forecast inspect --data data/demo.csv --config data/config.json
.venv/bin/python -m forecast train --data data/demo.csv --config data/config.json \
  --artifacts artifacts --run-id 00000000-0000-4000-8000-000000000001 \
  --series-id 00000000-0000-4000-8000-000000000002 --output artifacts/demo-result.json
.venv/bin/python -m forecast predict \
  --artifact artifacts/00000000-0000-4000-8000-000000000001 --data data/demo.csv
.venv/bin/python -m pytest services/model/tests -q
```

The supplied evaluated artifact can also be reloaded immediately using `--artifact data/demo-artifacts/00000000-0000-4000-8000-000000000001`. To forecast from later observations, supply the complete unchanged historical CSV with new rows appended at the same cadence. Prediction loads saved weights and scalers; it never trains. To improve or retrain the model, execute `train` with a new run UUID and full updated data. Reusing the same UUID and identical series, configuration, data and pipeline version returns the saved immutable result. A conflicting reuse is rejected.

CSV columns must be exactly `timestamp,value`. Timestamps must be increasing UTC ISO datetimes with `Z` or `+00:00`, at exact intervals of 24 hours (`D`) or one hour (`h`). Dates without times, other time zones, duplicates, missing periods and non-finite values are rejected. Values must have magnitude at most 1e12, with at most 50,000 observations per run. Perform any domain-specific aggregation or imputation upstream, and document it; this pipeline does not invent observations.

`data/config.json` contains the experiment settings. Configuration has a strict allowlist and bounds: horizon 1–90; season length 1–168; lags 2–336; epochs 1–500; integer seed 0–2147483647; training fraction 0.4–0.8; validation fraction 0.1–0.4, with their sum at most 0.95; interval alpha 0.01–0.5. Hourly defaults are 24 horizons, season length 24 and 48 lags. All defaults and effective values are saved with each run. `inspect` validates the input and reports whether each split has enough complete windows.

## Evaluation and leakage prevention

Each row predicts the next H observations from a known forecast origin. Features contain the previous L values, rolling means/standard deviations ending at the origin, the latest difference, and the known future calendar coordinates for each horizon. No feature accesses observations after the origin. Every model predicts all horizons directly. Seasonal naive repeats only the last observed season, including when H exceeds the season length.

Fractions partition raw target timestamps chronologically: training, validation and test. The validation block is divided into an earlier tuning half and later calibration half. Supervised windows whose H targets cross a block boundary are discarded. The first origin also requires enough past observations for both lag and seasonal windows. Training requires at least 16 complete origins, tuning and test at least five each, and calibration at least `max(10, ceil(1/alpha)-1)`. Inadequate data raise a descriptive error; decreasing horizon/lags, changing fractions or adding observations can resolve it.

Feature and target scalers learn from training windows only. Naive and seasonal-naive baselines, ridge regression with tuning-selected alpha from 0.1/1/10, and a PyTorch CPU MLP with hidden layers of 64 and 32 units are compared. The MLP trains with Adam, learning rate 0.001, batch size 64, gradient clipping and tuning-MAE early stopping with patience 12. The exact best checkpoint is restored. Family selection uses only tuning MAE. Candidate held-out test metrics are then reported for comparison; they never affect selection. Weights and scalers remain frozen at the training block, including when producing the latest forecast. There is no silent refit across calibration or test targets.

Held-out metrics use all complete test origins. Each successive origin may condition its prediction on actual observations that are already known by that time, while the model remains fixed. This models live rolling forecasts, rather than a single forecast made at the start of the test block. MAE, RMSE, percentage sMAPE and seasonal MASE are reported overall and by horizon. MASE uses only raw training-block seasonal differences; it becomes JSON `null` if that scale is zero or unavailable. sMAPE contributes zero where both prediction and actual are zero. Aggregated metrics average all origin/horizon pairs, so a timestamp can contribute at multiple horizons. The response retains the latest 500 history rows and at most 1,200 complete-origin backtest points; metrics still use the complete test block.

Prediction intervals use the finite-sample order statistic `ceil((m+1)*(1-alpha))` of absolute calibration residuals separately per horizon. Intervals are symmetric, can be negative, and are not clipped to a domain-specific lower bound. Overlapping windows and serial dependence mean nominal coverage has **no distribution-free guarantee**; drift can further reduce coverage. The result reports actual held-out coverage and average interval width. Repeatedly optimizing against the same test result compromises its independence: reserve a fresh later holdout for further model iterations.

## Artifacts and reproducibility

Each run folder saves `manifest.json` (data hash, config, feature schema, split boundaries, runtime/platform, dependency versions and checksums), `result.json`, full `observations.json`, `training.json` including MLP traces, `preprocessing.npz` including calibration radii, and the selected model's `model.npz` or `weights.pt`. Baselines need no weights. Ridge and scaler artifacts load with pickle disabled; neural weights load with `weights_only=True`. Checksums detect artifact corruption before inference; they are integrity checks for locally trusted artifacts, not signatures against a malicious artifact author.

Python, NumPy and PyTorch seeds are fixed, model training uses one CPU thread and deterministic PyTorch algorithms, and shuffling uses a seeded generator. The saved model is precisely the evaluated model. Exact reproducibility is tested within the same pinned runtime/platform. Different hardware, CPU linear-algebra builds or dependency versions can change floating-point results. `requirements.txt` and `constraints.txt` pin the tested common dependencies; platform-specific packages may additionally be resolved for the Linux CPU PyTorch wheel. Runtime metadata provides the exact execution environment.

Artifact commits use an atomic directory rename after every file is written. A filesystem lock serializes CPU/RNG operations and duplicate run requests on the shared artifact volume, and releases automatically after process death. Run the model service with one Uvicorn worker on a private network and use a reliable local/shared volume with POSIX file-lock/rename semantics. Multiple replicas with independent volumes are not covered by the shared lock. Application retraining scheduling and durable retries are owned by the Node/Postgres worker. Model artifacts contain source observations and should receive the same access controls and retention policy as training data.

## Internal API

```sh
# MODEL_SERVICE_TOKEN must contain at least 32 characters; use the same secret in Node.
export MODEL_SERVICE_TOKEN='replace-with-a-random-secret-of-at-least-32-characters'
export ARTIFACT_DIR=artifacts
PYTHONPATH=services/model .venv/bin/uvicorn forecast.api:app --host 127.0.0.1 --port 8000 --workers 1
```

`GET /health` returns readiness. `POST /train` requires `X-Service-Token` and a body containing UUID `run_id`, UUID `series_id`, `observations: [{timestamp,value}]`, and `config`. HTTP 401 rejects missing/wrong service credentials, 422 rejects input/config/split errors, and 409 rejects conflicting UUID reuse. API docs are disabled. The service is intended for the private worker network; end-user authorization and tenant scoping live in the Node API. A full response follows [the integration contract](../../docs/CONTRACT.md).

## Extension points

Start dataset-specific work with unit/cadence checks, seasonality and drift inspection, and a future holdout approved before tuning. Add exogenous predictors with explicit availability-at-origin rules to `features.py`; support additional model families in `models.py` and the candidate registry in `pipeline.py`. Version changes to feature meaning and artifact formats before deploying. For multiple series or irregular timestamps, add a separate ingestion/aggregation layer and an explicit evaluation protocol rather than combining unrelated observations into one series.
