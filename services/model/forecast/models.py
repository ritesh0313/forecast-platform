"""Small, inspectable model family. Learned preprocessing is fit on train only."""

from dataclasses import dataclass
import random
import numpy as np
import torch
from torch import nn


def seed_everything(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.set_num_threads(1)
    torch.use_deterministic_algorithms(True)


@dataclass
class Scaler:
    mean: np.ndarray
    scale: np.ndarray

    @classmethod
    def fit(cls, values: np.ndarray) -> "Scaler":
        mean, std = values.mean(axis=0), values.std(axis=0)
        return cls(mean, np.where(std < 1e-12, 1.0, std))

    def transform(self, values: np.ndarray) -> np.ndarray:
        return (values - self.mean) / self.scale

    def inverse(self, values: np.ndarray) -> np.ndarray:
        return values * self.scale + self.mean


class RidgeModel:
    def __init__(self, coefficient: np.ndarray, intercept: np.ndarray, alpha: float):
        self.coefficient, self.intercept, self.alpha = coefficient, intercept, alpha

    @classmethod
    def fit(cls, x: np.ndarray, y: np.ndarray, alpha: float) -> "RidgeModel":
        x_mean, y_mean = x.mean(axis=0), y.mean(axis=0)
        x_centered, y_centered = x - x_mean, y - y_mean
        # Choose the smaller linear system. Neither branch needs sklearn or pickle.
        if x.shape[1] <= x.shape[0]:
            matrix = x_centered.T @ x_centered + alpha * np.eye(x.shape[1])
            coefficient = np.linalg.solve(matrix, x_centered.T @ y_centered)
        else:
            matrix = x_centered @ x_centered.T + alpha * np.eye(x.shape[0])
            coefficient = x_centered.T @ np.linalg.solve(matrix, y_centered)
        return cls(coefficient, y_mean - x_mean @ coefficient, alpha)

    def predict(self, x: np.ndarray) -> np.ndarray:
        return x @ self.coefficient + self.intercept


class MLP(nn.Module):
    """Direct H-output dense network; an extensible supervised deep-learning baseline."""

    def __init__(self, input_size: int, horizon: int):
        super().__init__()
        self.network = nn.Sequential(nn.Linear(input_size, 64), nn.ReLU(),
                                     nn.Linear(64, 32), nn.ReLU(), nn.Linear(32, horizon))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.network(x)

    def predict(self, x: np.ndarray) -> np.ndarray:
        self.eval()
        with torch.no_grad():
            return self(torch.as_tensor(x, dtype=torch.float32)).cpu().numpy().astype(np.float64)


def fit_mlp(x: np.ndarray, y: np.ndarray, tune_x: np.ndarray, tune_y: np.ndarray,
            target_scaler: Scaler, epochs: int, seed: int) -> tuple[MLP, dict]:
    seed_everything(seed)
    model = MLP(x.shape[1], y.shape[1]).cpu()
    optimizer = torch.optim.Adam(model.parameters(), lr=0.001)
    inputs, targets = torch.as_tensor(x, dtype=torch.float32), torch.as_tensor(y, dtype=torch.float32)
    rng = np.random.default_rng(seed)
    best_score, best_state, best_epoch, stale = float("inf"), None, 0, 0
    trace = []
    for epoch in range(1, epochs + 1):
        model.train()
        order = rng.permutation(len(x))
        total = 0.0
        for start in range(0, len(x), 64):
            batch = order[start:start + 64]
            optimizer.zero_grad(set_to_none=True)
            loss = nn.functional.mse_loss(model(inputs[batch]), targets[batch])
            if not torch.isfinite(loss):
                raise ValueError("MLP training diverged; inspect input scale or reduce extremes")
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=5)
            optimizer.step()
            total += float(loss.detach()) * len(batch)
        tune_prediction = target_scaler.inverse(model.predict(tune_x))
        score = float(np.mean(np.abs(tune_prediction - tune_y)))
        trace.append({"epoch": epoch, "train_scaled_mse": total / len(x), "tune_mae": score})
        if score < best_score - 1e-6:
            best_score, best_epoch, stale = score, epoch, 0
            best_state = {key: value.detach().cpu().clone() for key, value in model.state_dict().items()}
        else:
            stale += 1
        if stale >= 12:
            break
    if best_state is None:
        raise ValueError("No finite MLP checkpoint was produced")
    model.load_state_dict(best_state)
    model.eval()
    return model, {"best_epoch": best_epoch, "epochs_run": len(trace), "hidden_sizes": [64, 32],
                   "learning_rate": 0.001, "batch_size": 64, "early_stopping_patience": 12, "trace": trace}


def baseline(name: str, values: np.ndarray, origins: np.ndarray, horizon: int, season_length: int) -> np.ndarray:
    if name == "naive":
        return np.repeat(values[origins, None], horizon, axis=1)
    if name == "seasonal_naive":
        # Repeat the last fully observed season for any horizon, including H > season.
        steps = np.arange(horizon) % season_length
        return values[origins[:, None] - season_length + 1 + steps[None, :]]
    raise ValueError(f"Unknown baseline {name}")
