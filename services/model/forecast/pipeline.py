"""Train, evaluate, calibrate and atomically persist one immutable experiment."""

from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import fcntl
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import shutil
import tempfile
from uuid import UUID, uuid4

import numpy as np
import torch

from . import __version__
from .config import Config
from .data import Series, iso, load_observations
from .features import feature_names, features_at, make_windows
from .metrics import calibrate_radius, evaluate, mase_scale
from .models import MLP, RidgeModel, Scaler, baseline, fit_mlp, seed_everything
from .splits import chronological_split


class RunConflict(ValueError):
    """A caller attempted to reuse an immutable run identifier with different input."""


def json_write(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def request_digest(series: Series, config: Config, series_id: str) -> str:
    value = {"data_hash": series.hash, "config": config.to_dict(), "series_id": series_id, "pipeline_version": __version__}
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


@contextmanager
def exclusive_lock(path: Path):
    # Advisory locks are released automatically on process death; lock files are safe to keep.
    with path.open("a") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def predict_candidate(name: str, model, x: np.ndarray, series: Series, origins: np.ndarray,
                      config: Config, x_scaler: Scaler, y_scaler: Scaler) -> np.ndarray:
    prediction = baseline(name, series.values, origins, config.horizon, config.season_length) if model is None else \
        y_scaler.inverse(model.predict(x_scaler.transform(x)))
    if prediction.shape != (len(origins), config.horizon) or not np.isfinite(prediction).all():
        raise ValueError(f"{name} produced non-finite or incorrectly shaped predictions")
    return prediction


def future_forecast(series: Series, config: Config, name: str, model, x_scaler: Scaler,
                    y_scaler: Scaler, radius: np.ndarray) -> list[dict]:
    if len(series.values) < max(config.lags, config.season_length):
        raise ValueError("Prediction requires at least max(lags,season_length) observations")
    origin = len(series.values) - 1
    try:
        x = features_at(series, origin, config)[None, :]
        prediction = predict_candidate(name, model, x, series, np.asarray([origin]), config, x_scaler, y_scaler)[0]
        return [{"timestamp": iso(series.timestamps[-1] + timedelta(seconds=i * config.step_seconds)),
                 "horizon": i, "predicted": float(value), "lower": float(value - radius[i - 1]),
                 "upper": float(value + radius[i - 1])} for i, value in enumerate(prediction, start=1)]
    except OverflowError as exc:
        raise ValueError("Forecast timestamps exceed supported datetime range") from exc


def _fit_run(series: Series, config: Config, series_id: str, run_id: str, folder: Path, digest: str) -> dict:
    seed_everything(config.seed)
    split = chronological_split(series, config)
    windows = {name: make_windows(series, origins, config) for name, origins in split.origins.items()}
    train_x, train_y = windows["train"]
    tune_x, tune_y = windows["tune"]
    x_scaler, y_scaler = Scaler.fit(train_x), Scaler.fit(train_y)
    scaled_train_x, scaled_train_y = x_scaler.transform(train_x), y_scaler.transform(train_y)
    scaled_tune_x = x_scaler.transform(tune_x)
    models = {"naive": None, "seasonal_naive": None}
    details = {"naive": {}, "seasonal_naive": {"season_length": config.season_length}}
    scores = {}
    for name in models:
        scores[name] = float(np.mean(np.abs(predict_candidate(name, None, tune_x, series, split.origins["tune"],
                                                             config, x_scaler, y_scaler) - tune_y)))
    ridge_trials = []
    best_ridge = None
    best_ridge_score = float("inf")
    for alpha in [0.1, 1.0, 10.0]:
        ridge = RidgeModel.fit(scaled_train_x, scaled_train_y, alpha)
        score = float(np.mean(np.abs(y_scaler.inverse(ridge.predict(scaled_tune_x)) - tune_y)))
        ridge_trials.append({"alpha": alpha, "tune_mae": score})
        if score < best_ridge_score:
            best_ridge, best_ridge_score = ridge, score
    if best_ridge is None or not np.isfinite(best_ridge_score):
        raise ValueError("No finite ridge candidate was produced")
    models["ridge"], scores["ridge"] = best_ridge, best_ridge_score
    details["ridge"] = {"alpha": best_ridge.alpha, "trials": ridge_trials}
    models["mlp"], details["mlp"] = fit_mlp(scaled_train_x, scaled_train_y, scaled_tune_x, tune_y,
                                            y_scaler, config.epochs, config.seed)
    scores["mlp"] = float(np.mean(np.abs(y_scaler.inverse(models["mlp"].predict(scaled_tune_x)) - tune_y)))
    # Freeze selection before reading calibration/test targets. Ties preserve family order.
    selected = min(scores, key=scores.get)
    calibration_x, calibration_y = windows["calibration"]
    calibration_prediction = predict_candidate(selected, models[selected], calibration_x, series,
                                               split.origins["calibration"], config, x_scaler, y_scaler)
    radius = calibrate_radius(calibration_y, calibration_prediction, config.interval_alpha)
    train_end = split.boundaries["train"][1]
    scale = mase_scale(series.values[:train_end], config.season_length)
    test_x, test_y = windows["test"]
    candidates, test_predictions = [], {}
    for name, model in models.items():
        prediction = predict_candidate(name, model, test_x, series, split.origins["test"], config, x_scaler, y_scaler)
        test_predictions[name] = prediction
        candidates.append({"name": name, "validation_mae": scores[name], "hyperparameters": {key: value for key, value in details[name].items() if key != "trace"},
                           "test_metrics": evaluate(test_y, prediction, scale)})
    selected_prediction = test_predictions[selected]
    backtest = []
    # Bound payload size while preserving all horizons for each retained origin.
    first_retained = max(0, len(test_y) - max(1, 1200 // config.horizon))
    for row_index in range(first_retained, len(test_y)):
        origin = int(split.origins["test"][row_index])
        for i in range(config.horizon):
            prediction = float(selected_prediction[row_index, i])
            backtest.append({"timestamp": iso(series.timestamps[origin + i + 1]), "origin": iso(series.timestamps[origin]),
                             "horizon": i + 1, "actual": float(test_y[row_index, i]), "predicted": prediction,
                             "lower": float(prediction - radius[i]), "upper": float(prediction + radius[i])})
    warnings = ["Prediction intervals use horizon-wise absolute residual quantiles on disjoint calibration data. "
                "Overlapping time-series windows are dependent; nominal coverage is not guaranteed and can fail under drift.",
                "Models and scalers are frozen at the training block. Later observed values condition rolling forecasts without refitting.",
                "The test set is a one-time evaluation. Repeated tuning against test metrics requires a fresh future holdout."]
    if scale is None:
        warnings.append("MASE is undefined because the training seasonal-naive scale is zero or unavailable; reported as null.")
    result = {"run_id": run_id, "series_id": series_id, "selected_model": selected,
              "trained_at": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
              "data_cutoff": iso(series.timestamps[-1]), "data_hash": series.hash,
              "sample_count": len(series.values), "config": config.to_dict(), "split": split.describe(series, config),
              "metrics": evaluate(test_y, selected_prediction, scale, radius), "candidates": candidates,
              "forecast": future_forecast(series, config, selected, models[selected], x_scaler, y_scaler, radius),
              "backtest": backtest, "history": series.observations()[-500:], "warnings": warnings,
              "artifact_path": run_id, "interval_method": {"name": "empirical absolute calibration residuals", "alpha": config.interval_alpha,
                                                          "calibration_origins": len(calibration_y), "radius_by_horizon": radius.tolist()}}
    np.savez(folder / "preprocessing.npz", x_mean=x_scaler.mean, x_scale=x_scaler.scale,
             y_mean=y_scaler.mean, y_scale=y_scaler.scale, interval_radius=radius)
    if selected == "ridge":
        np.savez(folder / "model.npz", coefficient=models[selected].coefficient, intercept=models[selected].intercept)
    elif selected == "mlp":
        torch.save(models[selected].state_dict(), folder / "weights.pt")
    json_write(folder / "observations.json", series.observations())
    json_write(folder / "training.json", {"candidates": details, "tune_scores": scores, "selected_model": selected})
    json_write(folder / "result.json", result)
    files = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in folder.iterdir() if path.is_file()}
    runtime = {"python": platform.python_version(), "platform": platform.platform(), "machine": platform.machine(),
               "dependencies": {name: importlib.metadata.version(name) for name in ["numpy", "torch", "fastapi", "pydantic", "uvicorn"]},
               "device": "cpu", "torch_threads": 1, "deterministic_algorithms": True}
    manifest = {"schema_version": 1, "pipeline_version": __version__, "request_digest": digest, "run_id": run_id,
                "series_id": series_id, "config": config.to_dict(), "selected_model": selected,
                "selected_hyperparameters": {key: value for key, value in details[selected].items() if key != "trace"},
                "data_hash": series.hash, "sample_count": len(series.values), "data_cutoff": result["data_cutoff"],
                "feature_names": feature_names(config), "split": result["split"], "runtime": runtime,
                "files_sha256": files, "training_mase_scale": scale,
                "preprocessing_fit": "train window features and targets only", "weights_fit": "train block only; exact evaluated checkpoint"}
    json_write(folder / "manifest.json", manifest)
    return result


def train(series: Series, config: Config, artifact_dir: str | Path, *, series_id: str | None = None,
          run_id: str | None = None) -> dict:
    series_id, run_id = str(UUID(series_id)) if series_id else str(uuid4()), str(UUID(run_id)) if run_id else str(uuid4())
    if series.frequency != config.frequency:
        raise ValueError("Series and experiment frequencies must agree")
    root = Path(artifact_dir)
    root.mkdir(parents=True, exist_ok=True)
    target, digest = root / run_id, request_digest(series, config, series_id)
    # Serialize CPU/RNG operations across callers sharing the artifact volume. Same run retries
    # return its immutable result; unique staging directories prevent partial visible artifacts.
    with exclusive_lock(root / ".training.lock"):
        if target.exists():
            manifest = json.loads((target / "manifest.json").read_text())
            if manifest["request_digest"] != digest:
                raise RunConflict("run_id already exists with different observations, series, config or pipeline version")
            verify_artifact(target, manifest)
            return json.loads((target / "result.json").read_text())
        staging = Path(tempfile.mkdtemp(prefix=f".{run_id}-", dir=root))
        try:
            result = _fit_run(series, config, series_id, run_id, staging, digest)
            os.rename(staging, target)
            return result
        finally:
            if staging.exists():
                shutil.rmtree(staging)


def verify_artifact(folder: Path, manifest: dict) -> None:
    if manifest.get("schema_version") != 1 or manifest.get("pipeline_version") != __version__:
        raise ValueError("Artifact schema/pipeline version is unsupported")
    for filename, expected in manifest["files_sha256"].items():
        if Path(filename).name != filename:
            raise ValueError("Artifact manifest has an invalid filename")
        path = folder / filename
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError(f"Artifact checksum mismatch: {filename}")


def predict(artifact_path: str | Path, observations: list[dict]) -> dict:
    folder = Path(artifact_path)
    manifest = json.loads((folder / "manifest.json").read_text())
    verify_artifact(folder, manifest)
    config = Config.from_dict(manifest["config"])
    series = load_observations(observations, config)
    prefix_count = manifest["sample_count"]
    if len(series.values) < prefix_count or load_observations(observations[:prefix_count], config).hash != manifest["data_hash"]:
        raise ValueError("Prediction input must preserve the full immutable run history, optionally followed by new observations")
    if manifest["feature_names"] != feature_names(config):
        raise ValueError("Artifact feature schema differs from this pipeline")
    with np.load(folder / "preprocessing.npz", allow_pickle=False) as preprocessing:
        x_scaler = Scaler(preprocessing["x_mean"], preprocessing["x_scale"])
        y_scaler = Scaler(preprocessing["y_mean"], preprocessing["y_scale"])
        radius = preprocessing["interval_radius"]
    name, model = manifest["selected_model"], None
    if name == "ridge":
        with np.load(folder / "model.npz", allow_pickle=False) as weights:
            model = RidgeModel(weights["coefficient"], weights["intercept"], manifest["selected_hyperparameters"]["alpha"])
    elif name == "mlp":
        seed_everything(config.seed)
        model = MLP(len(manifest["feature_names"]), config.horizon).cpu()
        model.load_state_dict(torch.load(folder / "weights.pt", map_location="cpu", weights_only=True))
        model.eval()
    elif name not in {"naive", "seasonal_naive"}:
        raise ValueError("Artifact contains an unsupported model family")
    return {"run_id": manifest["run_id"], "series_id": manifest["series_id"], "selected_model": name,
            "data_cutoff": iso(series.timestamps[-1]), "forecast": future_forecast(series, config, name, model, x_scaler, y_scaler, radius),
            "warnings": ["Frozen evaluated weights/scalers and original calibration intervals; appended data do not retrain the model."]}
