"""Map warehouse SKUs to observed dataset patterns and run batch XGBoost inference.

The mapping is intentionally labelled demo data: warehouse products do not exist
in FreshRetailNet or M5, so each SKU borrows the *shape* of a real observed
series and is scaled to a configurable demo demand level. The XGBoost model
trained on the pattern's source dataset then produces a 30-day forecast.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

import numpy as np
import pandas as pd
from xgboost import XGBRegressor

from ml.config import (
    APP_FORECASTS,
    APP_INVENTORY,
    APP_TARGET_DAILY_DEMAND,
    DEMAND_PATTERNS,
    FORECAST_HORIZON,
    HISTORY_DAYS,
    METRICS,
    MODELS,
)
from ml.pipeline.features import EPS
from ml.pipeline.jsonutil import write_json
from ml.pipeline.train import recursive_forecast


def _load_json(path):
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def _load_model(dataset: str):
    path = MODELS / f"xgb_{dataset}_final.json"
    if not path.exists():
        return None
    model = XGBRegressor()
    model.load_model(str(path))
    return model


def _frame(series_id: str, dates, units, stockout, promo, future=False):
    return pd.DataFrame(
        {
            "series_id": series_id,
            "date": pd.to_datetime(list(dates)),
            "units": units,
            "stockout": stockout,
            "promo": promo,
            "discount": np.nan,
            "price": np.nan,
            "holiday": 0,
        }
    )


def _forecast(model, history: pd.DataFrame, future: pd.DataFrame, horizon: int = FORECAST_HORIZON):
    series_id = history["series_id"].iloc[0]
    scale = max(float(history["units"].mean()), EPS)
    scales = pd.Series({series_id: scale})
    preds = recursive_forecast(model, history, future, scales, horizon=horizon)
    values = preds.get(series_id, [])
    if len(values) < horizon:
        values = values + [values[-1] if values else 0.0] * (horizon - len(values))
    return [max(0.0, float(v)) for v in values[:horizon]]


def _best_models(metrics) -> dict:
    """Pick the 30-day holdout winner for each dataset, never pooling datasets."""
    best = {}
    for dataset, result in (metrics or {}).get("datasets", {}).items():
        holdout = result.get("holdout", {})
        scores = {}
        for model in ("moving_average", "seasonal_naive", "xgboost"):
            wape = (holdout.get(model) or {}).get("30", {}).get("wape")
            if wape is not None:
                scores[model] = wape
        if scores:
            best[dataset] = min(scores, key=scores.get)
    return best


def _simple_forecast(units, horizon: int, model_name: str):
    history = [float(value) for value in units]
    if model_name == "moving_average":
        base = float(np.mean(history[-14:])) if history else 0.0
        return [max(0.0, base)] * horizon
    out = []
    for _ in range(horizon):
        value = history[-7] if len(history) >= 7 else (history[-1] if history else 0.0)
        value = max(0.0, float(value))
        out.append(value)
        history.append(value)
    return out


def _forecast_for(model_name, model, history, future, horizon=FORECAST_HORIZON):
    if model_name == "xgboost":
        return _forecast(model, history, future, horizon=horizon)
    return _simple_forecast(history["units"].tolist(), horizon, model_name)


def _backtest(model_name, model, history):
    if len(history) < 90:
        return {"mae": None, "wape": None}
    hist = history.iloc[:60].copy()
    future = history.iloc[60:].copy()
    preds = _forecast_for(model_name, model, hist, future, horizon=len(future))
    actual = future["units"].astype(float).to_numpy()
    errors = np.abs(np.asarray(preds) - actual)
    total_actual = float(actual.sum())
    return {
        "mae": round(float(errors.mean()), 4),
        "wape": round(float(errors.sum() / total_actual), 4) if total_actual > 0 else None,
        "mae_daily": round(float(errors.mean()), 4),
        "wape_30d": round(float(errors.sum() / total_actual), 4) if total_actual > 0 else None,
        "actual_30d": round(total_actual, 4),
        "predicted_30d": round(float(np.sum(preds)), 4),
    }


def run() -> dict:
    inventory = _load_json(APP_INVENTORY)
    pattern_payload = _load_json(DEMAND_PATTERNS)
    metrics = _load_json(METRICS)
    if not inventory or not pattern_payload:
        print("[map] missing app inventory or demand patterns; skipping", flush=True)
        return {"skus": []}

    patterns = pattern_payload.get("patterns", [])
    patterns = sorted(patterns, key=lambda item: item.get("mean_units", 0))
    best_models = _best_models(metrics)
    models = {}
    for dataset in ("freshretailnet", "m5"):
        model = _load_model(dataset)
        if model is not None:
            models[dataset] = model
    if not models or not patterns:
        print("[map] no trained models or patterns available; skipping", flush=True)
        return {"skus": []}

    items = sorted(inventory.get("items", []), key=lambda item: item["sku_id"])
    today = pd.Timestamp.now().normalize()
    history_end = today - pd.Timedelta(days=1)
    history_dates = pd.date_range(end=history_end, periods=HISTORY_DAYS)
    future_dates = pd.date_range(start=history_end + pd.Timedelta(days=1), periods=FORECAST_HORIZON)

    out = []
    pattern_step = 5 if len(patterns) > 5 else 1
    offset = 3 % len(patterns)
    for index, item in enumerate(items):
        pattern = None
        for attempt in range(len(patterns)):
            candidate = patterns[(index * pattern_step + offset + attempt) % len(patterns)]
            if candidate.get("dataset") in models and len(candidate.get("units", [])) >= HISTORY_DAYS:
                pattern = candidate
                break
        if pattern is None:
            continue

        dataset = pattern["dataset"]
        model = models[dataset]
        model_name = best_models.get(dataset, "xgboost")
        pattern_units = [float(v) for v in pattern["units"][-HISTORY_DAYS:]]
        pattern_mean = max(float(np.mean(pattern_units)), EPS)
        target = APP_TARGET_DAILY_DEMAND[index % len(APP_TARGET_DAILY_DEMAND)]
        scale = target / pattern_mean
        history_units = [round(max(0.0, value * scale), 4) for value in pattern_units]
        stockout = pattern.get("stockout") or [None] * HISTORY_DAYS
        promo = pattern.get("promo") or [0] * HISTORY_DAYS
        series_id = f"app:{item['sku_id']}"

        history = _frame(series_id, history_dates, history_units, stockout, promo)
        future = _frame(
            series_id,
            future_dates,
            [0.0] * FORECAST_HORIZON,
            [np.nan] * FORECAST_HORIZON,
            [0] * FORECAST_HORIZON,
            future=True,
        )
        forecast = _forecast_for(model_name, model, history, future, horizon=FORECAST_HORIZON)

        out.append(
            {
                "sku_id": item["sku_id"],
                "name": item.get("name", item["sku_id"]),
                "on_hand": item.get("on_hand"),
                "pattern_id": pattern["pattern_id"],
                "dataset": dataset,
                "dataset_series_id": pattern["series_id"],
                "dataset_product_id": pattern["product_id"],
                "dataset_store_id": pattern["store_id"],
                "category": pattern.get("category"),
                "scale_factor": round(scale, 6),
                "target_daily_demand": target,
                "history_units": history_units,
                "history_stockout": stockout,
                "history_promo": promo,
                "forecast_units": [round(value, 4) for value in forecast],
                "model_name": f"{model_name}_{dataset}",
                "model_label": {
                    "xgboost": f"XGBoost ({dataset} dataset)",
                    "seasonal_naive": f"Seasonal naive ({dataset} dataset)",
                    "moving_average": f"Moving average ({dataset} dataset)",
                }.get(model_name, f"{model_name} ({dataset} dataset)"),
                "backtest": _backtest(model_name, model, history),
            }
        )

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "history_days": HISTORY_DAYS,
        "horizon_days": FORECAST_HORIZON,
        "model_selection": best_models,
        "model_note": (
            "The best 30-day holdout model is selected separately per dataset. "
            "XGBoost is used when it beats the baselines; otherwise the seasonal-naive "
            "or moving-average baseline is used. Histories are real observed dataset "
            "patterns scaled to a clearly labelled demo demand level."
        ),
        "skus": out,
    }
    write_json(APP_FORECASTS, payload)
    print(f"[map] wrote {APP_FORECASTS} for {len(out)} SKUs", flush=True)
    return payload


if __name__ == "__main__":
    run()
