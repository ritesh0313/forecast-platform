"""Direct multi-horizon windows. Origin is the last known observation index."""

from datetime import timedelta
import math
import numpy as np

from .config import Config
from .data import Series


def feature_names(config: Config) -> list[str]:
    names = [f"lag_{i}" for i in range(1, config.lags + 1)]
    for window in sorted({min(7, config.lags), min(config.season_length, config.lags), config.lags}):
        names.extend([f"rolling_mean_{window}", f"rolling_std_{window}"])
    names.append("last_change")
    for horizon in range(1, config.horizon + 1):
        names.extend([f"h{horizon}_{name}" for name in ["time_trend", "week_sin", "week_cos", "year_sin", "year_cos"]])
        if config.frequency == "h":
            names.extend([f"h{horizon}_hour_sin", f"h{horizon}_hour_cos"])
    return names


def features_at(series: Series, origin: int, config: Config) -> np.ndarray:
    if not config.lags - 1 <= origin < len(series.values):
        raise ValueError("Origin must have a full past lag window")
    # All value features stop at origin. Future calendar coordinates are known in advance.
    past = series.values[origin - config.lags + 1:origin + 1]
    features = list(past[::-1])
    for window in sorted({min(7, config.lags), min(config.season_length, config.lags), config.lags}):
        features.extend([past[-window:].mean(), past[-window:].std()])
    features.append(past[-1] - past[-2])
    for horizon in range(1, config.horizon + 1):
        timestamp = series.timestamps[origin] + timedelta(seconds=horizon * config.step_seconds)
        week_angle = 2 * math.pi * (timestamp.weekday() + timestamp.hour / 24) / 7
        year_length = 366 if (timestamp.year % 4 == 0 and (timestamp.year % 100 != 0 or timestamp.year % 400 == 0)) else 365
        year_angle = 2 * math.pi * ((timestamp.timetuple().tm_yday - 1) + timestamp.hour / 24) / year_length
        features.extend([timestamp.timestamp() / config.step_seconds, math.sin(week_angle), math.cos(week_angle),
                         math.sin(year_angle), math.cos(year_angle)])
        if config.frequency == "h":
            hour_angle = 2 * math.pi * timestamp.hour / 24
            features.extend([math.sin(hour_angle), math.cos(hour_angle)])
    return np.asarray(features, dtype=np.float64)


def make_windows(series: Series, origins: np.ndarray, config: Config) -> tuple[np.ndarray, np.ndarray]:
    x = np.stack([features_at(series, int(origin), config) for origin in origins])
    y = np.stack([series.values[origin + 1:origin + 1 + config.horizon] for origin in origins])
    if y.shape != (len(origins), config.horizon) or not np.isfinite(x).all() or not np.isfinite(y).all():
        raise ValueError("Invalid windows: need finite features and complete future targets")
    return x, y
