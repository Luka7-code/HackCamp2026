"""Feature engineering shared by both dataset pipelines.

Demand is normalized per series so a single pooled XGBoost model can learn
across products with very different sales levels. All lag/rolling features are
shifted so the model never sees the value it is predicting.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

LAGS = (1, 7, 14, 28)
WINDOWS = (7, 14, 28)
EPS = 1e-6

FEATURE_COLUMNS = [
    "lag_1",
    "lag_7",
    "lag_14",
    "lag_28",
    "roll_mean_7",
    "roll_mean_14",
    "roll_mean_28",
    "roll_std_7",
    "dow",
    "month",
    "day",
    "weekofyear",
    "is_weekend",
    "promo",
    "holiday",
    "discount",
    "price_rel",
    "stockout_rate_7",
    "series_scale_log",
]


def compute_scales(df: pd.DataFrame) -> pd.Series:
    """Mean demand per series from the training window only."""
    return df.groupby("series_id", sort=False)["units"].mean().clip(lower=EPS)


def prepare_features(df: pd.DataFrame, scales: pd.Series) -> pd.DataFrame:
    df = df.sort_values(["series_id", "date"]).copy()
    df["series_scale"] = df["series_id"].map(scales).fillna(1.0).clip(lower=EPS)
    df["y"] = df["units"] / df["series_scale"]

    grouped = df.groupby("series_id", sort=False)["y"]
    for lag in LAGS:
        df[f"lag_{lag}"] = grouped.shift(lag)
    for window in WINDOWS:
        df[f"roll_mean_{window}"] = df.groupby("series_id", sort=False)["y"].transform(
            lambda s, w=window: s.shift(1).rolling(w, min_periods=max(2, w // 2)).mean()
        )
    df["roll_std_7"] = df.groupby("series_id", sort=False)["y"].transform(
        lambda s: s.shift(1).rolling(7, min_periods=2).std()
    )

    df["stockout_rate_7"] = df.groupby("series_id", sort=False)["stockout"].transform(
        lambda s: s.shift(1).rolling(7, min_periods=1).mean()
    )

    # Past-only relative price avoids leaking future price levels.
    df["price_rel"] = df["price"] / df.groupby("series_id", sort=False)["price"].transform(
        lambda s: s.shift(1).expanding(min_periods=1).mean()
    )

    df["dow"] = df["date"].dt.dayofweek.astype("int16")
    df["month"] = df["date"].dt.month.astype("int16")
    df["day"] = df["date"].dt.day.astype("int16")
    df["weekofyear"] = df["date"].dt.isocalendar().week.astype("int16")
    df["is_weekend"] = df["dow"].isin([5, 6]).astype("int16")
    df["promo"] = df["promo"].fillna(0).astype("int16")
    df["holiday"] = df["holiday"].fillna(0).astype("int16")
    df["series_scale_log"] = np.log1p(df["series_scale"])
    return df


def training_rows(df: pd.DataFrame) -> pd.DataFrame:
    """Rows with a full lag window and a valid target."""
    return df[df["lag_28"].notna() & df["y"].notna()].copy()
