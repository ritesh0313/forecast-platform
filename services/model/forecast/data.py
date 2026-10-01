"""Strict input contract: one finite series, chronological timestamps, no imputation."""

import csv
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import hashlib
import json
import math
from pathlib import Path
from typing import Iterable

import numpy as np

from .config import Config

MAX_OBSERVATIONS = 50_000
MAX_ABS_VALUE = 1e12


def parse_timestamp(value: str) -> datetime:
    if not isinstance(value, str) or "T" not in value:
        raise ValueError("timestamp must be an explicit UTC ISO datetime, e.g. 2025-01-01T00:00:00Z")
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"Invalid ISO timestamp: {value}") from exc
    if result.tzinfo is None or result.utcoffset() != timedelta(0):
        raise ValueError("timestamps must include UTC Z or +00:00; local times/offsets are not accepted")
    return result.astimezone(timezone.utc)


def iso(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


@dataclass(frozen=True)
class Series:
    timestamps: tuple[datetime, ...]
    values: np.ndarray
    frequency: str

    @property
    def hash(self) -> str:
        canonical = [{"timestamp": iso(t), "value": float(y)} for t, y in zip(self.timestamps, self.values)]
        return hashlib.sha256(json.dumps(canonical, separators=(",", ":"), allow_nan=False).encode()).hexdigest()

    def observations(self) -> list[dict]:
        return [{"timestamp": iso(t), "value": float(v)} for t, v in zip(self.timestamps, self.values)]


def load_observations(observations: Iterable[dict], config: Config) -> Series:
    timestamps, values = [], []
    for index, row in enumerate(observations):
        if index >= MAX_OBSERVATIONS:
            raise ValueError(f"A run supports at most {MAX_OBSERVATIONS} observations")
        if not isinstance(row, dict) or set(row) != {"timestamp", "value"}:
            raise ValueError(f"Observation {index + 1} must contain exactly timestamp and value")
        timestamp = parse_timestamp(row["timestamp"])
        raw = row["value"]
        if isinstance(raw, bool) or not isinstance(raw, (int, float, str)):
            raise ValueError(f"Observation {index + 1} value must be numeric")
        try:
            value = float(raw)
        except (ValueError, TypeError, OverflowError) as exc:
            raise ValueError(f"Observation {index + 1} value must be numeric") from exc
        if not math.isfinite(value) or abs(value) > MAX_ABS_VALUE:
            raise ValueError(f"Observation {index + 1} must be finite and magnitude at most {MAX_ABS_VALUE:g}")
        if timestamps and timestamp - timestamps[-1] != timedelta(seconds=config.step_seconds):
            raise ValueError(f"Observation {index + 1} has duplicate, unordered, or missing timestamps; expected exact {config.frequency} cadence")
        timestamps.append(timestamp)
        values.append(value)
    if not timestamps:
        raise ValueError("No observations supplied")
    array = np.asarray(values, dtype=np.float64)
    array.setflags(write=False)
    return Series(tuple(timestamps), array, config.frequency)


def load_csv(path: str | Path, config: Config) -> Series:
    with Path(path).open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames != ["timestamp", "value"]:
            raise ValueError("CSV header must be timestamp,value (one series per file)")
        return load_observations(reader, config)


def inspect(series: Series) -> dict:
    values = series.values
    return {"sample_count": len(values), "frequency": series.frequency, "start": iso(series.timestamps[0]),
            "end": iso(series.timestamps[-1]), "min": float(values.min()), "max": float(values.max()),
            "mean": float(values.mean()), "data_hash": series.hash, "missing_values": 0,
            "cadence": "regular UTC; no missing timestamps or imputation"}
