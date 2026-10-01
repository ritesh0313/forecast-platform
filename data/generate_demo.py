"""Generate synthetic daily demand; this is not the user's historical dataset."""

import argparse
import csv
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default=str(Path(__file__).with_name("demo.csv")))
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--samples", type=int, default=730)
    args = parser.parse_args()
    rng = np.random.default_rng(args.seed)
    index = np.arange(args.samples)
    start = datetime(2024, 1, 1, tzinfo=timezone.utc)
    values = 110 + 0.025 * index + 15 * np.sin(2 * np.pi * index / 7) + 8 * np.sin(2 * np.pi * index / 365.25) + rng.normal(0, 2.8, args.samples)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["timestamp", "value"])
        for day, value in zip(index, values):
            writer.writerow([(start + timedelta(days=int(day))).isoformat().replace("+00:00", "Z"), f"{value:.6f}"])


if __name__ == "__main__":
    main()
