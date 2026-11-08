"""Train and evaluate demand-forecasting models per public dataset.

Two evaluation views are produced:
  * holdout: the last 30 days of the same series used for training
  * unseen_series: FreshRetailNet's separate eval file (cross-series check)

A pooled XGBoost model is trained on normalized demand so it can learn across
products with different sales levels. Baselines are a 14-day moving average and
a seasonal-naive (lag-7) forecast.
"""

from __future__ import annotations

import time
from datetime import datetime, timezone

import numpy as np
import pandas as pd
from xgboost import XGBRegressor

from ml.config import MODELS, SEED, TEST_DAYS, FORECAST_HORIZON
from ml.pipeline.features import (
    FEATURE_COLUMNS,
    compute_scales,
    prepare_features,
    training_rows,
)
from ml.pipeline.jsonutil import write_json

HORIZONS = (7, 14, 30)

XGB_PARAMS = dict(
    n_estimators=350,
    max_depth=6,
    learning_rate=0.07,
    subsample=0.85,
    colsample_bytree=0.85,
    min_child_weight=5,
    reg_lambda=1.0,
    objective="reg:squarederror",
    eval_metric="mae",
    tree_method="hist",
    n_jobs=-1,
    random_state=SEED,
    early_stopping_rounds=25,
)


def split_train_test(df: pd.DataFrame, test_days: int = TEST_DAYS):
    df = df.sort_values(["series_id", "date"]).copy()
    rank = df.groupby("series_id", sort=False)["date"].rank(method="first", ascending=False)
    test = rank <= test_days
    return df[~test].copy(), df[test].copy()


def _fit(df: pd.DataFrame, scales: pd.Series, n_estimators: int | None = None, early_stop: bool = True):
    prepared = prepare_features(df, scales)
    rows = training_rows(prepared)
    if rows.empty:
        raise RuntimeError("No training rows after feature engineering")

    params = {k: v for k, v in XGB_PARAMS.items() if k != "early_stopping_rounds"}
    if n_estimators is not None:
        params["n_estimators"] = max(50, int(n_estimators))

    if early_stop:
        cutoff = rows["date"].max() - pd.Timedelta(days=14)
        fit_rows = rows[rows["date"] <= cutoff]
        val_rows = rows[rows["date"] > cutoff]
        if fit_rows.empty or val_rows.empty:
            fit_rows, val_rows = rows, rows.tail(min(len(rows), 1000))
        params["early_stopping_rounds"] = XGB_PARAMS["early_stopping_rounds"]
        model = XGBRegressor(**params)
        model.fit(
            fit_rows[FEATURE_COLUMNS],
            fit_rows["y"],
            eval_set=[(val_rows[FEATURE_COLUMNS], val_rows["y"])],
            verbose=False,
        )
    else:
        model = XGBRegressor(**params)
        model.fit(rows[FEATURE_COLUMNS], rows["y"], verbose=False)
    return model


def _feature_row(
    units_hist,
    stockout_hist,
    price_hist,
    scale,
    date,
    promo,
    holiday,
    discount,
    price,
):
    u = np.asarray(units_hist, dtype=float) / scale
    n = len(u)

    def lag(k):
        return float(u[-k]) if n >= k else np.nan

    def roll_mean(w):
        if n < max(2, w // 2):
            return np.nan
        return float(np.mean(u[-w:]))

    def roll_std(w):
        if n < 2:
            return np.nan
        return float(np.std(u[-w:], ddof=1)) if n >= w else float(np.std(u, ddof=1))

    stock = np.asarray(stockout_hist, dtype=float) if stockout_hist else np.array([])
    stock_rate = float(np.nanmean(stock[-7:])) if len(stock) and not np.all(np.isnan(stock[-7:])) else np.nan

    past_prices = np.asarray(price_hist, dtype=float) if price_hist else np.array([])
    past_prices = past_prices[~np.isnan(past_prices)]
    price_rel = (
        float(price) / float(np.mean(past_prices))
        if price is not None and not pd.isna(price) and len(past_prices) and np.mean(past_prices) > 0
        else np.nan
    )

    return {
        "lag_1": lag(1),
        "lag_7": lag(7),
        "lag_14": lag(14),
        "lag_28": lag(28),
        "roll_mean_7": roll_mean(7),
        "roll_mean_14": roll_mean(14),
        "roll_mean_28": roll_mean(28),
        "roll_std_7": roll_std(7),
        "dow": date.dayofweek,
        "month": date.month,
        "day": date.day,
        "weekofyear": int(date.isocalendar().week),
        "is_weekend": int(date.dayofweek in (5, 6)),
        "promo": 0 if pd.isna(promo) else int(promo),
        "holiday": 0 if pd.isna(holiday) else int(holiday),
        "discount": np.nan if pd.isna(discount) else float(discount),
        "price_rel": price_rel,
        "stockout_rate_7": stock_rate,
        "series_scale_log": float(np.log1p(scale)),
    }


def recursive_forecast(model, history_df: pd.DataFrame, future_df: pd.DataFrame, scales: pd.Series, horizon: int = FORECAST_HORIZON):
    history = {}
    for sid, group in history_df.sort_values(["series_id", "date"]).groupby("series_id", sort=False):
        history[sid] = {
            "units": group["units"].astype(float).tolist(),
            "stockout": group["stockout"].astype(float).tolist(),
            "price": group["price"].astype(float).tolist(),
        }
    futures = {}
    for sid, group in future_df.sort_values(["series_id", "date"]).groupby("series_id", sort=False):
        futures[sid] = group.head(horizon).to_dict(orient="records")

    series_ids = [sid for sid in futures if sid in history]
    preds = {sid: [] for sid in series_ids}

    for step in range(horizon):
        rows = []
        row_ids = []
        for sid in series_ids:
            future_rows = futures[sid]
            if step >= len(future_rows):
                continue
            f = future_rows[step]
            h = history[sid]
            rows.append(
                _feature_row(
                    h["units"],
                    h["stockout"],
                    h["price"],
                    float(scales.get(sid, 1.0)),
                    pd.Timestamp(f["date"]),
                    f.get("promo"),
                    f.get("holiday"),
                    f.get("discount"),
                    f.get("price"),
                )
            )
            row_ids.append(sid)
        if not rows:
            break
        X = pd.DataFrame(rows, columns=FEATURE_COLUMNS)
        yhat = np.clip(model.predict(X), 0, None)
        for sid, value in zip(row_ids, yhat):
            units = float(value) * float(scales.get(sid, 1.0))
            preds[sid].append(units)
            history[sid]["units"].append(units)
            history[sid]["stockout"].append(np.nan)
            history[sid]["price"].append(np.nan)
    return preds


def moving_average_forecast(history_df: pd.DataFrame, horizon: int = FORECAST_HORIZON, window: int = 14):
    preds = {}
    for sid, group in history_df.sort_values(["series_id", "date"]).groupby("series_id", sort=False):
        values = group["units"].astype(float).to_numpy()
        base = float(np.mean(values[-window:])) if len(values) else 0.0
        preds[sid] = [max(0.0, base)] * horizon
    return preds


def seasonal_naive_forecast(history_df: pd.DataFrame, horizon: int = FORECAST_HORIZON, season: int = 7):
    preds = {}
    for sid, group in history_df.sort_values(["series_id", "date"]).groupby("series_id", sort=False):
        hist = group["units"].astype(float).tolist()
        out = []
        for _ in range(horizon):
            value = hist[-season] if len(hist) >= season else (hist[-1] if hist else 0.0)
            value = max(0.0, float(value))
            out.append(value)
            hist.append(value)
        preds[sid] = out
    return preds


def horizon_metrics(preds: dict, actuals: dict) -> dict:
    result = {}
    for horizon in HORIZONS:
        errors = []
        actual_sum = 0.0
        for sid in set(preds) & set(actuals):
            p = float(np.sum(preds[sid][:horizon]))
            a = float(np.sum(actuals[sid][:horizon]))
            errors.append(abs(p - a))
            actual_sum += a
        mae = float(np.mean(errors)) if errors else None
        wape = float(np.sum(errors) / actual_sum) if actual_sum > 0 else None
        result[str(horizon)] = {
            "mae": round(mae, 4) if mae is not None else None,
            "wape": round(wape, 4) if wape is not None else None,
            "n_series": len(errors),
        }
    return result


def evaluate_on(df: pd.DataFrame, model, test_days: int = TEST_DAYS) -> dict:
    history_df, future_df = split_train_test(df, test_days=test_days)
    scales = compute_scales(history_df)
    actuals = {
        sid: group.sort_values("date")["units"].astype(float).tolist()
        for sid, group in future_df.groupby("series_id", sort=False)
    }
    xgb_preds = recursive_forecast(model, history_df, future_df, scales)
    ma_preds = moving_average_forecast(history_df)
    naive_preds = seasonal_naive_forecast(history_df)
    return {
        "moving_average": horizon_metrics(ma_preds, actuals),
        "seasonal_naive": horizon_metrics(naive_preds, actuals),
        "xgboost": horizon_metrics(xgb_preds, actuals),
        "series": len(actuals),
        "history_days": int(history_df.groupby("series_id").size().median()) if len(history_df) else 0,
        "test_days": int(future_df.groupby("series_id").size().median()) if len(future_df) else 0,
    }


def _importance(model) -> list:
    pairs = sorted(
        zip(FEATURE_COLUMNS, model.feature_importances_.tolist()),
        key=lambda item: item[1],
        reverse=True,
    )
    return [{"feature": name, "importance": round(float(value), 5)} for name, value in pairs[:15]]


def train_dataset(dataset_id: str, train_df: pd.DataFrame, eval_df: pd.DataFrame | None = None) -> dict:
    started = time.time()
    MODELS.mkdir(parents=True, exist_ok=True)

    train_part, _ = split_train_test(train_df, test_days=TEST_DAYS)
    train_scales = compute_scales(train_part)
    model = _fit(train_part, train_scales)

    holdout = evaluate_on(train_df, model, test_days=TEST_DAYS)

    unseen = None
    if eval_df is not None and not eval_df.empty:
        # The FreshRetailNet eval release is a 7-day horizon without history;
        # only evaluate unseen series when there is enough history to forecast.
        median_days = float(eval_df.groupby("series_id").size().median())
        if median_days >= TEST_DAYS + 14:
            unseen = evaluate_on(eval_df, model, test_days=TEST_DAYS)

    # Retrain on every available row for application inference, using the
    # iteration count selected by the early-stopping evaluation model.
    best_iteration = int(getattr(model, "best_iteration", XGB_PARAMS["n_estimators"] - 1) or 0) + 1
    full_scales = compute_scales(train_df)
    final_model = _fit(train_df, full_scales, n_estimators=best_iteration, early_stop=False)
    final_path = MODELS / f"xgb_{dataset_id}_final.json"
    final_model.save_model(str(final_path))

    result = {
        "dataset_id": dataset_id,
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "model": {
            "name": "xgboost",
            "type": "pooled normalized-demand regressor",
            "params": {k: v for k, v in XGB_PARAMS.items() if k not in ("n_jobs", "early_stopping_rounds")},
            "best_iteration": best_iteration,
            "artifact": str(final_path.relative_to(MODELS.parent.parent)),
        },
        "training": {
            "series": int(train_df["series_id"].nunique()),
            "rows": int(len(train_df)),
            "date_min": str(train_df["date"].min().date()),
            "date_max": str(train_df["date"].max().date()),
        },
        "holdout": holdout,
        "unseen_series": unseen,
        "feature_importance": _importance(final_model),
        "elapsed_seconds": round(time.time() - started, 1),
    }
    return result


def save_metrics(all_results: list, path) -> None:
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "horizons": list(HORIZONS),
        "datasets": {result["dataset_id"]: result for result in all_results},
        "notes": [
            "Metrics are computed on cumulative demand over 7, 14 and 30 days.",
            "WAPE = sum(|predicted - actual|) / sum(actual).",
            "XGBoost is trained per dataset; datasets are never combined.",
            "FreshRetailNet sale_amount is globally normalized and stockout-censored.",
            "M5 has no stockout labels, so no supervised stockout model is trained.",
            "FreshRetailNet's separate eval release has only a 7-day horizon without history, "
            "so it is registered but not used for the 30-day holdout evaluation.",
            "The best 30-day holdout model is selected separately per dataset for app forecasts.",
        ],
    }
    write_json(path, payload)