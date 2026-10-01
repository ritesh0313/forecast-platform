from copy import deepcopy
import json
import numpy as np
import pytest

from forecast.config import Config
from forecast.data import load_observations
from forecast.features import feature_names, features_at, make_windows
from forecast.metrics import calibrate_radius, evaluate, mase_scale
from forecast.models import Scaler, baseline
from forecast.splits import chronological_split
from conftest import make_observations


@pytest.mark.parametrize("mutation", ["duplicate", "gap", "offset", "local", "nan", "bool"])
def test_reject_ambiguous_or_incomplete_input(observations, config, mutation):
    rows = deepcopy(observations)
    if mutation == "duplicate":
        rows[1]["timestamp"] = rows[0]["timestamp"]
    elif mutation == "gap":
        del rows[1]
    elif mutation == "offset":
        rows[0]["timestamp"] = "2025-01-01T00:00:00+05:30"
    elif mutation == "local":
        rows[0]["timestamp"] = "2025-01-01T00:00:00"
    elif mutation == "nan":
        rows[0]["value"] = float("nan")
    else:
        rows[0]["value"] = True
    with pytest.raises(ValueError):
        load_observations(rows, config)


def test_features_never_read_future_values(observations, config, series):
    altered = deepcopy(observations)
    for row in altered[51:]:
        row["value"] += 9000
    future_changed = load_observations(altered, config)
    np.testing.assert_array_equal(features_at(series, 50, config), features_at(future_changed, 50, config))
    assert len(feature_names(config)) == len(features_at(series, 50, config))
    x, y = make_windows(series, np.asarray([50]), config)
    np.testing.assert_array_equal(x[0, :config.lags], series.values[44:51][::-1])
    np.testing.assert_array_equal(y[0], series.values[51:54])


def test_purged_splits_have_disjoint_complete_targets(series, config):
    split = chronological_split(series, config)
    targets = []
    for name, origins in split.origins.items():
        start, end = split.boundaries[name]
        target_set = set()
        for origin in origins:
            assert origin + 1 >= start
            assert origin + config.horizon < end
            target_set.update(range(origin + 1, origin + config.horizon + 1))
        targets.append(target_set)
    for i, left in enumerate(targets):
        for right in targets[i + 1:]:
            assert not left & right


def test_preprocessing_is_insensitive_to_later_blocks(observations, series, config):
    split = chronological_split(series, config)
    x, y = make_windows(series, split.origins["train"], config)
    altered = deepcopy(observations)
    for row in altered[split.boundaries["train"][1]:]:
        row["value"] = -1e6
    later_changed = load_observations(altered, config)
    new_x, new_y = make_windows(later_changed, split.origins["train"], config)
    for before, after in [(x, new_x), (y, new_y)]:
        np.testing.assert_array_equal(Scaler.fit(before).mean, Scaler.fit(after).mean)
        np.testing.assert_array_equal(Scaler.fit(before).scale, Scaler.fit(after).scale)


def test_seasonal_naive_repeats_only_observed_season():
    values = np.arange(10, dtype=float)
    prediction = baseline("seasonal_naive", values, np.asarray([6]), 7, 3)
    np.testing.assert_array_equal(prediction, [[4, 5, 6, 4, 5, 6, 4]])


def test_metrics_zero_scale_is_null_and_zero_smape_is_defined():
    actual = np.zeros((4, 2))
    metrics = evaluate(actual, actual, mase_scale(np.zeros(20), 7), np.ones(2))
    assert metrics["mae"] == metrics["rmse"] == metrics["smape"] == 0
    assert metrics["mase"] is None
    assert metrics["interval_coverage"] == 1
    assert metrics["interval_mean_width"] == 2
    json.dumps(metrics, allow_nan=False)


def test_calibration_order_statistic_and_insufficient_data():
    actual, predicted = np.arange(10).reshape(-1, 1), np.zeros((10, 1))
    np.testing.assert_array_equal(calibrate_radius(actual, predicted, .1), [9])
    with pytest.raises(ValueError, match="Too few calibration"):
        calibrate_radius(actual[:3], predicted[:3], .01)


def test_hourly_config_and_invalid_config_bounds():
    config = Config.from_dict({"frequency": "h"})
    assert config.horizon == config.season_length == 24 and config.lags == 48
    assert len(load_observations(make_observations(500, frequency="h"), config).values) == 500
    for kwargs in [[], False, {1: "bad"}, {"epochs": True}, {"frequency": "m"}, {"unknown": 1}, {"train_fraction": .8, "validation_fraction": .2}]:
        with pytest.raises(ValueError):
            Config.from_dict(kwargs)


def test_small_dataset_explains_required_block_size(config):
    with pytest.raises(ValueError, match="Too little data"):
        chronological_split(load_observations(make_observations(40), config), config)
