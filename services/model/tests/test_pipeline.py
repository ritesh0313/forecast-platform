from copy import deepcopy
from dataclasses import replace
from datetime import timedelta
import hashlib
import json
import re
from uuid import uuid4
import numpy as np
import pytest

from forecast.data import iso, load_observations
from forecast.features import make_windows
from forecast.models import RidgeModel, Scaler, fit_mlp
from forecast.pipeline import RunConflict, predict, train
from forecast.splits import chronological_split


def test_train_reload_idempotence_and_appended_prediction(tmp_path, series, config, observations):
    run_id, series_id = str(uuid4()), str(uuid4())
    result = train(series, config, tmp_path, run_id=run_id, series_id=series_id)
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", result["trained_at"])
    saved = tmp_path / run_id
    assert predict(saved, observations)["forecast"] == result["forecast"]
    assert train(series, config, tmp_path, run_id=run_id, series_id=series_id) == result
    manifest = json.loads((saved / "manifest.json").read_text())
    assert manifest["data_hash"] == series.hash
    assert manifest["weights_fit"] == "train block only; exact evaluated checkpoint"
    assert manifest["runtime"]["device"] == "cpu"
    assert len(result["candidates"]) == 4
    assert len(result["metrics"]["by_horizon"]) == config.horizon
    assert result["metrics"]["origin_count"] == result["split"]["test"]["origin_count"]
    json.dumps(result, allow_nan=False)
    extended = observations + [{"timestamp": iso(series.timestamps[-1] + timedelta(days=1)), "value": 99}]
    appended = predict(saved, extended)
    assert appended["forecast"][0]["timestamp"] == iso(series.timestamps[-1] + timedelta(days=2))
    changed = deepcopy(observations)
    changed[0]["value"] += 1
    with pytest.raises(ValueError, match="immutable run history"):
        predict(saved, changed)
    with pytest.raises(RunConflict):
        train(series, replace(config, seed=config.seed + 1), tmp_path, run_id=run_id, series_id=series_id)
    # Corruption fails closed before reconstructing weights.
    (saved / "preprocessing.npz").write_bytes(b"bad")
    with pytest.raises(ValueError, match="checksum mismatch"):
        predict(saved, observations)


def test_calibration_and_test_data_do_not_change_selected_weights(tmp_path, series, config, observations):
    split = chronological_split(series, config)
    changed = deepcopy(observations)
    for row in changed[split.boundaries["calibration"][0]:]:
        row["value"] += 100
    altered = load_observations(changed, config)
    series_id = str(uuid4())
    before = train(series, config, tmp_path, series_id=series_id)
    after = train(altered, config, tmp_path, series_id=series_id)
    assert before["selected_model"] == after["selected_model"]
    for a, b in zip(before["candidates"], after["candidates"]):
        assert a["validation_mae"] == b["validation_mae"]
    before_path, after_path = tmp_path / before["run_id"], tmp_path / after["run_id"]
    for filename in ["model.npz", "weights.pt"]:
        if (before_path / filename).exists():
            assert hashlib.sha256((before_path / filename).read_bytes()).hexdigest() == hashlib.sha256((after_path / filename).read_bytes()).hexdigest()
    with np.load(before_path / "preprocessing.npz") as a, np.load(after_path / "preprocessing.npz") as b:
        for key in ["x_mean", "x_scale", "y_mean", "y_scale"]:
            np.testing.assert_array_equal(a[key], b[key])
    assert before["interval_method"]["radius_by_horizon"] != after["interval_method"]["radius_by_horizon"]


def test_mlp_training_reproducible_and_checkpoint_selected_on_tune(series, config):
    split = chronological_split(series, config)
    x, y = make_windows(series, split.origins["train"], config)
    tune_x, tune_y = make_windows(series, split.origins["tune"], config)
    x_scaler, y_scaler = Scaler.fit(x), Scaler.fit(y)
    args = (x_scaler.transform(x), y_scaler.transform(y), x_scaler.transform(tune_x), tune_y, y_scaler, 4, 42)
    first, first_info = fit_mlp(*args)
    second, second_info = fit_mlp(*args)
    np.testing.assert_array_equal(first.predict(x_scaler.transform(tune_x)), second.predict(x_scaler.transform(tune_x)))
    assert first_info == second_info
    assert first_info["best_epoch"] == min(first_info["trace"], key=lambda row: row["tune_mae"])["epoch"]


def test_mlp_selected_artifact_reload(tmp_path, observations, config, monkeypatch):
    # Deliberately handicap ridge, so this exercises persisted neural weights.
    rows = deepcopy(observations)
    for i, row in enumerate(rows):
        row["value"] = 10 if i % 2 else -10
    config = replace(config, horizon=1, epochs=20)
    def bad_ridge(cls, x, y, alpha):
        return RidgeModel(np.zeros((x.shape[1], y.shape[1])), np.ones(y.shape[1]) * 1000, alpha)
    monkeypatch.setattr(RidgeModel, "fit", classmethod(bad_ridge))
    series = load_observations(rows, config)
    result = train(series, config, tmp_path)
    assert result["selected_model"] == "mlp"
    assert (tmp_path / result["run_id"] / "weights.pt").is_file()
    assert predict(tmp_path / result["run_id"], rows)["forecast"] == result["forecast"]
