"""All metrics are JSON-safe; MASE scaling uses only raw training observations."""

import math
import numpy as np


def mase_scale(training_values: np.ndarray, season_length: int) -> float | None:
    if len(training_values) <= season_length:
        return None
    scale = float(np.mean(np.abs(training_values[season_length:] - training_values[:-season_length])))
    return scale if math.isfinite(scale) and scale > 1e-12 else None


def compute_metrics(actual: np.ndarray, predicted: np.ndarray, scale: float | None,
                    radius: np.ndarray | None = None) -> dict:
    if actual.shape != predicted.shape or not np.isfinite(actual).all() or not np.isfinite(predicted).all():
        raise ValueError("Metrics require equally shaped finite actual and predicted arrays")
    error = predicted - actual
    absolute = np.abs(error)
    denominator = np.abs(actual) + np.abs(predicted)
    smape = np.divide(200 * absolute, denominator, out=np.zeros_like(absolute), where=denominator > 0)
    mae = float(absolute.mean())
    result = {"mae": mae, "rmse": float(np.sqrt(np.mean(error ** 2))), "smape": float(smape.mean()),
              "mase": mae / scale if scale is not None else None}
    if radius is not None:
        result |= {"interval_coverage": float(np.mean(absolute <= radius[None, :])),
                   "interval_mean_width": float(2 * radius.mean())}
    return result


def evaluate(actual: np.ndarray, predicted: np.ndarray, scale: float | None,
             radius: np.ndarray | None = None) -> dict:
    result = compute_metrics(actual, predicted, scale, radius)
    result["by_horizon"] = [{"horizon": i + 1, **compute_metrics(actual[:, i:i + 1], predicted[:, i:i + 1], scale,
                                                               radius[i:i + 1] if radius is not None else None)}
                            for i in range(actual.shape[1])]
    result["origin_count"] = len(actual)
    return result


def calibrate_radius(actual: np.ndarray, predicted: np.ndarray, alpha: float) -> np.ndarray:
    residuals = np.abs(actual - predicted)
    if not np.isfinite(residuals).all() or len(residuals) == 0:
        raise ValueError("Calibration requires finite residuals")
    # Finite-sample order statistic. Time dependence means no coverage guarantee.
    rank = math.ceil((len(residuals) + 1) * (1 - alpha))
    if rank > len(residuals):
        raise ValueError("Too few calibration origins for interval_alpha; add data or increase alpha")
    return np.sort(residuals, axis=0)[rank - 1]
