"""Adapter for the M5 Walmart Forecasting (Accuracy) competition data.

The adapter reads the official competition CSV files and maps them onto the
standardized internal schema. M5 has no stockout labels, so `stockout` is left
as null instead of being fabricated.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from ml.config import (
    M5_CALENDAR,
    M5_PRICES,
    M5_RAW_DIR,
    M5_SALES,
    M5_TRAIN_SERIES,
    SEED,
)
from ml.adapters.base import validate_standard_frame

META_COLS = ["id", "item_id", "dept_id", "cat_id", "store_id", "state_id"]
LAST_DAY = 1941  # final training/evaluation day in sales_train_evaluation.csv


class M5Adapter:
    dataset_id = "m5"

    def inspect(self) -> dict:
        meta = pd.read_csv(M5_SALES, usecols=META_COLS, dtype=str)
        calendar = pd.read_csv(M5_CALENDAR, parse_dates=["date"])
        prices = pd.read_csv(M5_PRICES, usecols=["store_id", "item_id", "wm_yr_wk", "sell_price"])
        return {
            "dataset_id": self.dataset_id,
            "files": {
                "sales": str(M5_SALES),
                "calendar": str(M5_CALENDAR),
                "prices": str(M5_PRICES),
            },
            "series": int(len(meta)),
            "items": int(meta["item_id"].nunique()),
            "stores": int(meta["store_id"].nunique()),
            "categories": sorted(meta["cat_id"].unique().tolist()),
            "date_min": str(calendar["date"].min().date()),
            "date_max": str(calendar["date"].max().date()),
            "sales_columns": LAST_DAY,
            "price_rows": int(len(prices)),
            "price_missing": float(prices["sell_price"].isna().mean()),
            "notes": [
                "Daily unit sales are used as demand (not normalized).",
                "SNAP and calendar events are used as promotion features.",
                "No stockout labels exist; stockout risk is computed downstream.",
            ],
        }

    def _sample_series(self, meta: pd.DataFrame, max_series: int, seed: int) -> pd.DataFrame:
        rng = np.random.default_rng(seed)
        parts = []
        for _, group in meta.groupby("cat_id", sort=True):
            n = max(1, int(round(max_series * len(group) / len(meta))))
            n = min(n, len(group))
            chosen = rng.choice(len(group), size=n, replace=False)
            parts.append(group.iloc[np.sort(chosen)])
        sample = pd.concat(parts, ignore_index=True)
        if len(sample) > max_series:
            sample = sample.sample(n=max_series, random_state=seed).reset_index(drop=True)
        return sample

    def load(self, max_series: int = M5_TRAIN_SERIES, days: int = 365, seed: int = SEED) -> pd.DataFrame:
        meta = pd.read_csv(M5_SALES, usecols=META_COLS, dtype=str)
        sample = self._sample_series(meta, max_series=max_series, seed=seed)
        sample_ids = set(sample["id"])

        first_day = LAST_DAY - days + 1
        day_cols = [f"d_{i}" for i in range(first_day, LAST_DAY + 1)]

        sales = pd.read_csv(
            M5_SALES,
            usecols=META_COLS + day_cols,
            dtype={c: "int32" for c in day_cols} | {c: "string" for c in META_COLS},
        )
        sales = sales[sales["id"].isin(sample_ids)].copy()

        long = sales.melt(
            id_vars=META_COLS,
            value_vars=day_cols,
            var_name="d",
            value_name="units",
        )

        calendar = pd.read_csv(
            M5_CALENDAR,
            usecols=[
                "date",
                "wm_yr_wk",
                "d",
                "event_name_1",
                "event_type_1",
                "event_name_2",
                "event_type_2",
                "snap_CA",
                "snap_TX",
                "snap_WI",
            ],
            parse_dates=["date"],
        )
        long = long.merge(calendar, on="d", how="left", validate="many_to_one")

        state = long["state_id"].astype(str)
        snap = np.select(
            [state.eq("CA"), state.eq("TX")],
            [long["snap_CA"], long["snap_TX"]],
            default=long["snap_WI"],
        )
        long["promo"] = (
            long["event_name_1"].notna() | long["event_name_2"].notna() | pd.Series(snap, index=long.index).eq(1)
        ).astype("int8")
        holiday_types = {"National", "Religious"}
        long["holiday"] = (
            long["event_type_1"].isin(holiday_types) | long["event_type_2"].isin(holiday_types)
        ).astype("int8")

        # Read prices in chunks and keep only the sampled item/store pairs.
        items = set(sample["item_id"])
        stores = set(sample["store_id"])
        price_parts = []
        for chunk in pd.read_csv(
            M5_PRICES,
            usecols=["store_id", "item_id", "wm_yr_wk", "sell_price"],
            chunksize=1_000_000,
            dtype={"store_id": "string", "item_id": "string", "wm_yr_wk": "int32", "sell_price": "float64"},
        ):
            mask = chunk["item_id"].isin(items) & chunk["store_id"].isin(stores)
            if mask.any():
                price_parts.append(chunk.loc[mask])
        prices = (
            pd.concat(price_parts, ignore_index=True)
            if price_parts
            else pd.DataFrame(columns=["store_id", "item_id", "wm_yr_wk", "sell_price"])
        )
        long = long.merge(prices, on=["store_id", "item_id", "wm_yr_wk"], how="left", validate="many_to_one")

        out = pd.DataFrame(
            {
                "dataset": "m5",
                "series_id": "m5:" + long["store_id"].astype(str) + ":" + long["item_id"].astype(str),
                "store_id": long["store_id"],
                "product_id": long["item_id"],
                "product_category": long["cat_id"].astype(str) + "/" + long["dept_id"].astype(str),
                "date": long["date"],
                "units": long["units"].astype("float64"),
                "stockout": np.nan,
                "promo": long["promo"],
                "discount": np.nan,
                "price": long["sell_price"],
                "holiday": long["holiday"],
                "temperature": np.nan,
                "precipitation": np.nan,
                "humidity": np.nan,
            }
        )
        return validate_standard_frame(out, self.dataset_id)
