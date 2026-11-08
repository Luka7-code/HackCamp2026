"""Select representative 90-day demand patterns from each public dataset.

These patterns are the bridge from the public datasets to the warehouse app:
each app SKU is mapped to one observed pattern and scaled to a clearly labelled
demo demand level (see map_to_app.py).
"""

from __future__ import annotations

from datetime import datetime, timezone

import numpy as np
import pandas as pd

from ml.config import DEMAND_PATTERNS, HISTORY_DAYS
from ml.pipeline.jsonutil import write_json


def select_patterns(df: pd.DataFrame, dataset_id: str, count: int = 12) -> list:
    candidates = []
    for series_id, group in df.groupby("series_id", sort=False):
        group = group.sort_values("date").tail(HISTORY_DAYS)
        if len(group) < HISTORY_DAYS:
            continue
        units = group["units"].astype(float).to_numpy()
        mean_units = float(np.nanmean(units))
        if not np.isfinite(mean_units) or mean_units <= 0:
            continue
        # Patterns whose most recent 30 days are all zero are poor demo priors.
        if float(np.nansum(units[-30:])) <= 0:
            continue
        std = float(np.nanstd(units))
        stockout = group["stockout"].tolist() if group["stockout"].notna().any() else [None] * len(group)
        promo = group["promo"].fillna(0).astype(int).tolist()
        candidates.append(
            {
                "pattern_id": f"{dataset_id}:{series_id}",
                "dataset": dataset_id,
                "series_id": series_id,
                "store_id": str(group["store_id"].iloc[-1]),
                "product_id": str(group["product_id"].iloc[-1]),
                "category": str(group["product_category"].iloc[-1]),
                "dates": [d.date().isoformat() for d in group["date"].tolist()],
                "units": [round(float(v), 5) for v in units],
                "stockout": stockout,
                "promo": promo,
                "mean_units": round(mean_units, 5),
                "cv": round(std / mean_units, 5) if mean_units > 0 else None,
                "stockout_days": int(sum(1 for v in stockout if v == 1)),
                "promo_days": int(sum(promo)),
            }
        )
    if not candidates:
        return []

    candidates.sort(key=lambda item: item["mean_units"])
    indices = np.linspace(0, len(candidates) - 1, num=min(count, len(candidates)))
    chosen = []
    used = set()
    for index in indices.round().astype(int):
        item = candidates[int(index)]
        if item["pattern_id"] in used:
            continue
        used.add(item["pattern_id"])
        chosen.append(item)
    return chosen


def save_patterns(patterns: list) -> None:
    write_json(
        DEMAND_PATTERNS,
        {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "history_days": HISTORY_DAYS,
            "pattern_count": len(patterns),
            "patterns": patterns,
            "notes": [
                "Patterns are observed 90-day demand histories from the public datasets.",
                "App SKUs are mapped to a pattern and scaled to a demo demand level; "
                "the mapping is labelled as demo data in the UI and database.",
                "M5 has no stockout labels, so its stockout arrays contain null.",
            ],
        },
    )
