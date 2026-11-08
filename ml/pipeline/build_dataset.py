"""Build standardized Parquet datasets and a data-quality report."""

from __future__ import annotations

from datetime import datetime, timezone

import pandas as pd

from ml.adapters.freshretailnet_adapter import FreshRetailNetAdapter
from ml.adapters.m5_adapter import M5Adapter
from ml.config import (
    DATASET_REPORT,
    DATA_PROCESSED,
    FRESH_DATASET,
    FRESH_EVAL,
    FRESH_EVAL_PROCESSED,
    FRESH_EVAL_SERIES,
    FRESH_PROCESSED,
    FRESH_RAW_DIR,
    FRESH_TRAIN,
    FRESH_TRAIN_SERIES,
    HISTORY_DAYS,
    M5_DATASET,
    M5_PROCESSED,
    M5_RAW_DIR,
    M5_TRAIN_SERIES,
)
from ml.pipeline.jsonutil import write_json


def summarize(df: pd.DataFrame) -> dict:
    per_series = df.groupby("series_id")["units"]
    return {
        "series": int(df["series_id"].nunique()),
        "rows": int(len(df)),
        "stores": int(df["store_id"].nunique()),
        "products": int(df["product_id"].nunique()),
        "date_min": str(df["date"].min().date()),
        "date_max": str(df["date"].max().date()),
        "days_median": float(per_series.size().median()),
        "units_mean": round(float(df["units"].mean()), 4),
        "units_median": round(float(df["units"].median()), 4),
        "units_zero_share": round(float((df["units"] == 0).mean()), 4),
        "stockout_rate": round(float(df["stockout"].mean()), 4) if df["stockout"].notna().any() else None,
        "promo_rate": round(float(df["promo"].mean()), 4),
        "missing": {
            col: round(float(df[col].isna().mean()), 4)
            for col in ("stockout", "discount", "price", "temperature", "precipitation", "humidity")
        },
    }


def _raw_files(directory) -> list:
    return [
        {"name": path.name, "bytes": path.stat().st_size}
        for path in sorted(directory.glob("*"))
        if path.is_file()
    ]


def build(force: bool = False) -> dict:
    DATA_PROCESSED.mkdir(parents=True, exist_ok=True)

    if force or not FRESH_PROCESSED.exists():
        print("[build] FreshRetailNet train sample ...", flush=True)
        fresh_train = FreshRetailNetAdapter(FRESH_TRAIN).load(
            max_series=FRESH_TRAIN_SERIES, days=HISTORY_DAYS
        )
        fresh_train.to_parquet(FRESH_PROCESSED, index=False)
    else:
        fresh_train = pd.read_parquet(FRESH_PROCESSED)

    if force or not FRESH_EVAL_PROCESSED.exists():
        print("[build] FreshRetailNet eval sample ...", flush=True)
        fresh_eval = FreshRetailNetAdapter(FRESH_EVAL).load(
            max_series=FRESH_EVAL_SERIES, days=HISTORY_DAYS
        )
        fresh_eval.to_parquet(FRESH_EVAL_PROCESSED, index=False)
    else:
        fresh_eval = pd.read_parquet(FRESH_EVAL_PROCESSED)

    if force or not M5_PROCESSED.exists():
        print("[build] M5 sample ...", flush=True)
        m5 = M5Adapter().load(max_series=M5_TRAIN_SERIES, days=365)
        m5.to_parquet(M5_PROCESSED, index=False)
    else:
        m5 = pd.read_parquet(M5_PROCESSED)

    print("[build] inspecting raw schemas ...", flush=True)
    fresh_inspection = FreshRetailNetAdapter(FRESH_TRAIN).inspect()
    m5_inspection = M5Adapter().inspect()

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "datasets": {
            "freshretailnet": {
                **FRESH_DATASET,
                "raw_files": _raw_files(FRESH_RAW_DIR),
                "full_dataset": {
                    "series": 50000,
                    "stores": 898,
                    "products": 865,
                    "days": 90,
                    "stockout_share": "approximately 20% organically occurring stockout records",
                },
                "inspection": fresh_inspection,
                "train_sample": summarize(fresh_train),
                "eval_sample": summarize(fresh_eval),
            },
            "m5": {
                **M5_DATASET,
                "raw_files": _raw_files(M5_RAW_DIR),
                "full_dataset": {
                    "series": 30490,
                    "items": 3049,
                    "stores": 10,
                    "days": 1941,
                    "categories": ["FOODS", "HOBBIES", "HOUSEHOLD"],
                    "stockout_labels": "not available",
                },
                "inspection": m5_inspection,
                "train_sample": summarize(m5),
            },
        },
        "sampling": {
            "freshretailnet_train_series": FRESH_TRAIN_SERIES,
            "freshretailnet_eval_series": FRESH_EVAL_SERIES,
            "m5_series": M5_TRAIN_SERIES,
            "seed": 42,
            "note": (
                "Samples are stratified by category so training stays tractable; "
                "the full raw files are downloaded and retained separately."
            ),
        },
    }
    write_json(DATASET_REPORT, report)
    print(f"[build] wrote {DATASET_REPORT}", flush=True)
    return report


if __name__ == "__main__":
    build(force=False)
