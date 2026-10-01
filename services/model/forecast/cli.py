"""CLI for local reproducible experiments and reload-only prediction."""

import argparse
import json
from pathlib import Path
import sys

from .config import Config
from .data import inspect, load_csv
from .pipeline import json_write, predict, train
from .splits import chronological_split


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    for command in ("inspect", "train"):
        sub = subparsers.add_parser(command)
        sub.add_argument("--data", required=True, help="CSV timestamp,value with exact D or h UTC cadence")
        sub.add_argument("--config", help="JSON experiment config; unknown fields rejected")
        sub.add_argument("--output", help="Also save JSON result to this path")
        if command == "train":
            sub.add_argument("--artifacts", default="artifacts", help="Atomic per-run artifact root")
            sub.add_argument("--run-id", help="Optional immutable UUID; same input returns existing run")
            sub.add_argument("--series-id", help="Optional series UUID")
    sub = subparsers.add_parser("predict")
    sub.add_argument("--artifact", required=True, help="Path to one saved run folder")
    sub.add_argument("--data", required=True, help="Full original CSV history, optionally with appended observations")
    sub.add_argument("--output", help="Also save JSON predictions to this path")
    args = parser.parse_args()
    try:
        if args.command == "predict":
            manifest = json.loads((Path(args.artifact) / "manifest.json").read_text())
            series = load_csv(args.data, Config.from_dict(manifest["config"]))
            result = predict(args.artifact, series.observations())
        else:
            config = Config.from_dict(json.loads(Path(args.config).read_text()) if args.config else {})
            series = load_csv(args.data, config)
            if args.command == "train":
                result = train(series, config, args.artifacts, run_id=args.run_id, series_id=args.series_id)
            else:
                result = inspect(series)
                try:
                    result |= {"training_feasible": True, "split": chronological_split(series, config).describe(series, config)}
                except ValueError as exc:
                    result |= {"training_feasible": False, "reason": str(exc)}
        if args.output:
            output = Path(args.output)
            output.parent.mkdir(parents=True, exist_ok=True)
            json_write(output, result)
        print(json.dumps(result, indent=2, allow_nan=False))
    except (ValueError, OSError, json.JSONDecodeError) as exc:
        print(f"forecast: {exc}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
