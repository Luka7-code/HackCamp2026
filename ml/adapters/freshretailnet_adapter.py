"""Adapter for FreshRetailNet-50K (TsFile release).

The dataset provides 90-day store-product series with hourly sales and hourly
stock status. This adapter keeps the daily fields needed for forecasting and
uses `sale_amount` as the demand target (the release applies a global
normalization coefficient, so values are demand-equivalent, not raw units).
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from ml.config import FRESH_TRAIN_SERIES, SEED
from ml.adapters.base import validate_standard_frame


class FreshRetailNetAdapter:
    dataset_id = "freshretailnet"

    def __init__(self, path):
        self.path = path

    # ---------- low-level helpers ----------
    def _open(self):
        from tsfile import TsFileReader

        reader = TsFileReader(str(self.path))
        schemas = reader.get_all_table_schemas()
        if not schemas:
            reader.close()
            raise RuntimeError(f"No table found in {self.path}")
        table_name = next(iter(schemas))
        columns = [c.get_column_name() for c in schemas[table_name].get_columns()]
        return reader, table_name, columns

    @staticmethod
    def _time_column(columns):
        for candidate in ("Time", "time", "dt", "date"):
            if candidate in columns:
                return candidate
        # The TsFile reader exposes the primary time column implicitly even
        # though get_columns() does not list it.
        return "time"

    @staticmethod
    def _pick(columns, *candidates, required=True, default=None):
        for candidate in candidates:
            if candidate in columns:
                return candidate
        if required:
            raise RuntimeError(f"None of {candidates} present in {columns}")
        return default

    def _iter_batches(self, fields, batch_size=131072):
        reader, table_name, _ = self._open()
        try:
            with reader.query_table(table_name, fields, batch_size=batch_size) as result:
                while True:
                    batch = result.read_arrow_batch()
                    if batch is None:
                        break
                    if batch.num_rows == 0:
                        continue
                    yield batch.to_pandas()
        finally:
            reader.close()

    # ---------- public API ----------
    def inspect(self) -> dict:
        reader, table_name, columns = self._open()
        try:
            sample = None
            with reader.query_table(table_name, columns[: min(8, len(columns))], batch_size=5) as result:
                batch = result.read_arrow_batch()
                if batch is not None:
                    sample = batch.to_pandas().head(3).to_dict(orient="records")
        finally:
            reader.close()
        return {
            "dataset_id": self.dataset_id,
            "path": str(self.path),
            "table": table_name,
            "columns": columns,
            "implicit_time_column": "time",
            "sample": sample,
            "notes": [
                "sale_amount is globally normalized sales amount, used as demand.",
                "stock_hour6_22_cnt > 0 marks an organic stockout day.",
                "Hourly sequence columns are intentionally not loaded.",
            ],
        }

    def load(self, max_series: int = FRESH_TRAIN_SERIES, days: int = 90, seed: int = SEED) -> pd.DataFrame:
        # Pass 1: discover series and categories without loading hourly columns.
        reader, table_name, columns = self._open()
        store_col = self._pick(columns, "store_id")
        product_col = self._pick(columns, "product_id")
        cat_cols = [
            self._pick(columns, "first_category_id", required=False),
            self._pick(columns, "second_category_id", required=False),
            self._pick(columns, "third_category_id", required=False),
        ]
        cat_cols = [c for c in cat_cols if c]
        meta_fields = [store_col, product_col] + cat_cols
        seen = set()
        try:
            with reader.query_table(table_name, meta_fields, batch_size=131072) as result:
                while True:
                    batch = result.read_arrow_batch()
                    if batch is None:
                        break
                    df = batch.to_pandas()
                    for row in df[meta_fields].itertuples(index=False, name=None):
                        seen.add(row)
        finally:
            reader.close()

        meta = pd.DataFrame(list(seen), columns=meta_fields)
        rng = np.random.default_rng(seed)
        strat_col = cat_cols[-1] if cat_cols else None
        parts = []
        if strat_col:
            for _, group in meta.groupby(strat_col, sort=True):
                n = max(1, int(round(max_series * len(group) / len(meta))))
                n = min(n, len(group))
                chosen = rng.choice(len(group), size=n, replace=False)
                parts.append(group.iloc[np.sort(chosen)])
        else:
            n = min(max_series, len(meta))
            parts.append(meta.iloc[np.sort(rng.choice(len(meta), size=n, replace=False))])
        sample = pd.concat(parts, ignore_index=True)
        if len(sample) > max_series:
            sample = sample.sample(n=max_series, random_state=seed).reset_index(drop=True)
        selected = set(zip(sample[store_col].astype(str), sample[product_col].astype(str)))

        # Pass 2: load daily fields for the sampled series only.
        time_col = self._time_column(columns)
        sale_col = self._pick(columns, "sale_amount", "sales", "units")
        stock_col = self._pick(columns, "stock_hour6_22_cnt", required=False)
        discount_col = self._pick(columns, "discount", required=False)
        holiday_col = self._pick(columns, "holiday_flag", required=False)
        activity_col = self._pick(columns, "activity_flag", required=False)
        precip_col = self._pick(columns, "precpt", "precipitation", required=False)
        temp_col = self._pick(columns, "avg_temperature", "temperature", required=False)
        humid_col = self._pick(columns, "avg_humidity", "humidity", required=False)
        fields = [store_col, product_col, sale_col] + cat_cols
        for c in (stock_col, discount_col, holiday_col, activity_col, precip_col, temp_col, humid_col):
            if c and c not in fields:
                fields.append(c)
        # query_table rejects the implicit time column if it is not in the schema.
        fields = [f for f in fields if f in columns]

        frames = []
        for batch in self._iter_batches(fields):
            key = list(zip(batch[store_col].astype(str), batch[product_col].astype(str)))
            mask = np.fromiter((k in selected for k in key), dtype=bool, count=len(key))
            if mask.any():
                frames.append(batch.loc[mask])
        if not frames:
            raise RuntimeError("No rows loaded from FreshRetailNet sample")
        df = pd.concat(frames, ignore_index=True)

        if pd.api.types.is_numeric_dtype(df[time_col]):
            df["date"] = pd.to_datetime(df[time_col], unit="ms", utc=True)
        else:
            df["date"] = pd.to_datetime(df[time_col], utc=True)
        df["date"] = df["date"].dt.tz_convert(None).dt.normalize()
        df = df.sort_values(["date"]).groupby([store_col, product_col], sort=False).tail(days)

        if stock_col:
            stockout = (pd.to_numeric(df[stock_col], errors="coerce").fillna(0) > 0).astype("int8")
        else:
            stockout = np.nan
        if activity_col:
            promo = pd.to_numeric(df[activity_col], errors="coerce").fillna(0).eq(1)
        else:
            promo = pd.Series(False, index=df.index)
        if discount_col:
            promo = promo | pd.to_numeric(df[discount_col], errors="coerce").fillna(1).lt(1)

        out = pd.DataFrame(
            {
                "dataset": "freshretailnet",
                "series_id": "frn:" + df[store_col].astype(str) + ":" + df[product_col].astype(str),
                "store_id": df[store_col].astype(str),
                "product_id": df[product_col].astype(str),
                "product_category": (
                    df[cat_cols].astype(str).agg("/".join, axis=1) if cat_cols else "unknown"
                ),
                "date": df["date"],
                "units": pd.to_numeric(df[sale_col], errors="coerce").astype("float64"),
                "stockout": stockout,
                "promo": promo.astype("int8"),
                "discount": pd.to_numeric(df[discount_col], errors="coerce") if discount_col else np.nan,
                "price": np.nan,
                "holiday": (
                    pd.to_numeric(df[holiday_col], errors="coerce").fillna(0).astype("int8")
                    if holiday_col
                    else 0
                ),
                "temperature": pd.to_numeric(df[temp_col], errors="coerce") if temp_col else np.nan,
                "precipitation": pd.to_numeric(df[precip_col], errors="coerce") if precip_col else np.nan,
                "humidity": pd.to_numeric(df[humid_col], errors="coerce") if humid_col else np.nan,
            }
        )
        return validate_standard_frame(out, self.dataset_id)
