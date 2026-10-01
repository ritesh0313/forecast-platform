from datetime import datetime, timedelta, timezone
import numpy as np
import pytest

from forecast.config import Config
from forecast.data import iso, load_observations


def make_observations(count=200, *, frequency="D", seed=11):
    start = datetime(2025, 1, 1, tzinfo=timezone.utc)
    rng = np.random.default_rng(seed)
    index = np.arange(count)
    values = 40 + .08 * index + 5 * np.sin(2 * np.pi * index / 7) + rng.normal(0, .2, count)
    step = timedelta(days=1) if frequency == "D" else timedelta(hours=1)
    return [{"timestamp": iso(start + i * step), "value": float(value)} for i, value in enumerate(values)]


@pytest.fixture
def config():
    return Config(horizon=3, lags=7, season_length=7, epochs=3)


@pytest.fixture
def observations():
    return make_observations()


@pytest.fixture
def series(observations, config):
    return load_observations(observations, config)
