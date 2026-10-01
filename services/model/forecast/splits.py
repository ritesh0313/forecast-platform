"""Disjoint target blocks; windows crossing each boundary are purged."""

from dataclasses import dataclass
import math
import numpy as np

from .config import Config
from .data import Series, iso


@dataclass(frozen=True)
class Split:
    origins: dict[str, np.ndarray]
    boundaries: dict[str, tuple[int, int]]

    def describe(self, series: Series, config: Config) -> dict:
        result = {"strategy": "chronological disjoint target blocks; crossing horizon windows purged",
                  "purge_between_blocks": config.horizon - 1, "validation_strategy": "first half tune, second half calibration",
                  "weights_fit_on": "train only; no refit after tuning", "test_strategy": "fixed-model rolling-origin",
                  "mase_scale_fit_on": "raw training target block only"}
        for name, (start, end) in self.boundaries.items():
            origins = self.origins[name]
            result[name] = {"target_start_index": start, "target_end_index_exclusive": end,
                            "target_start": iso(series.timestamps[start]), "target_end": iso(series.timestamps[end - 1]),
                            "origin_count": len(origins), "first_origin": iso(series.timestamps[int(origins[0])]),
                            "last_origin": iso(series.timestamps[int(origins[-1])])}
        return result


def chronological_split(series: Series, config: Config) -> Split:
    count = len(series.values)
    train_end = int(count * config.train_fraction)
    calibration_end = int(count * (config.train_fraction + config.validation_fraction))
    tune_end = train_end + (calibration_end - train_end) // 2
    boundaries = {"train": (0, train_end), "tune": (train_end, tune_end),
                  "calibration": (tune_end, calibration_end), "test": (calibration_end, count)}
    origins = {}
    minimums = {"train": 16, "tune": 5, "calibration": max(10, math.ceil(1 / config.interval_alpha) - 1), "test": 5}
    for name, (start, end) in boundaries.items():
        # origin+1 >= start and origin+horizon < end: no target crosses blocks.
        first = max(config.lags - 1, config.season_length - 1, start - 1)
        last_exclusive = end - config.horizon
        origins[name] = np.arange(first, last_exclusive, dtype=np.int64)
        if len(origins[name]) < minimums[name]:
            raise ValueError(f"Too little data for {name}: {len(origins[name])} complete origins, need {minimums[name]}. "
                             "Add observations, lower horizon/lags/season_length, or increase the relevant fraction/interval_alpha.")
    return Split(origins, boundaries)
