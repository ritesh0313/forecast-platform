"""Validated experiment settings shared by the CLI and HTTP service."""

from dataclasses import asdict, dataclass
import math


@dataclass(frozen=True)
class Config:
    horizon: int = 7
    frequency: str = "D"
    season_length: int = 7
    lags: int = 28
    epochs: int = 80
    seed: int = 42
    train_fraction: float = 0.6
    validation_fraction: float = 0.25
    interval_alpha: float = 0.1

    def __post_init__(self) -> None:
        if self.frequency not in {"D", "h"}:
            raise ValueError("frequency must be D (24 hours) or h (1 hour), in UTC")
        bounds = {"horizon": (1, 90), "season_length": (1, 168), "lags": (2, 336),
                  "epochs": (1, 500), "seed": (0, 2_147_483_647)}
        for name, (low, high) in bounds.items():
            value = getattr(self, name)
            if type(value) is not int or not low <= value <= high:
                raise ValueError(f"{name} must be an integer between {low} and {high}")
        for name, low, high in [("train_fraction", 0.4, 0.8), ("validation_fraction", 0.1, 0.4),
                                ("interval_alpha", 0.01, 0.5)]:
            value = getattr(self, name)
            if type(value) not in (int, float) or not math.isfinite(value) or not low <= value <= high:
                raise ValueError(f"{name} must be a finite number between {low} and {high}")
        if self.train_fraction + self.validation_fraction > 0.95 + 1e-12:
            raise ValueError("train_fraction + validation_fraction must be at most 0.95")

    @classmethod
    def from_dict(cls, values: dict | None = None) -> "Config":
        values = {} if values is None else values
        if not isinstance(values, dict):
            raise ValueError("config must be an object")
        if any(not isinstance(key, str) for key in values):
            raise ValueError("config keys must be strings")
        unknown = set(values) - set(cls.__dataclass_fields__)
        if unknown:
            raise ValueError(f"Unknown config keys: {', '.join(sorted(unknown))}")
        defaults = {"horizon": 24, "season_length": 24, "lags": 48} if values.get("frequency") == "h" else {}
        return cls(**(defaults | values))

    def to_dict(self) -> dict:
        return asdict(self)

    @property
    def step_seconds(self) -> int:
        return 86400 if self.frequency == "D" else 3600
