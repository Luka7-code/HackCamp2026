"""The standardized internal ML schema shared by every dataset adapter."""

import pandas as pd

# Both adapters must emit these columns. Dataset-specific fields are kept in
# separate optional columns rather than being forced into a common shape.
STANDARD_COLUMNS = [
    "dataset",
    "series_id",
    "store_id",
    "product_id",
    "product_category",
    "date",
    "units",
    "stockout",
    "promo",
    "discount",
    "price",
    "holiday",
    "temperature",
    "precipitation",
    "humidity",
]


def validate_standard_frame(df: pd.DataFrame, dataset: str) -> pd.DataFrame:
    missing = [c for c in STANDARD_COLUMNS if c not in df.columns]
    if missing:
        raise ValueError(f"{dataset}: missing standardized columns: {missing}")

    df = df[STANDARD_COLUMNS].copy()
    df["dataset"] = df["dataset"].fillna(dataset).astype(str)
    df["series_id"] = df["series_id"].astype(str)
    df["store_id"] = df["store_id"].astype(str)
    df["product_id"] = df["product_id"].astype(str)
    df["product_category"] = df["product_category"].fillna("unknown").astype(str)
    df["date"] = pd.to_datetime(df["date"]).dt.tz_localize(None).dt.normalize()
    df["units"] = pd.to_numeric(df["units"], errors="coerce").astype("float64")
    df = df[df["units"].notna()].copy()
    df["stockout"] = pd.to_numeric(df["stockout"], errors="coerce").astype("float64")
    df["promo"] = pd.to_numeric(df["promo"], errors="coerce").fillna(0).astype("int8")
    for col in ("discount", "price", "temperature", "precipitation", "humidity"):
        df[col] = pd.to_numeric(df[col], errors="coerce").astype("float64")
    df["holiday"] = pd.to_numeric(df["holiday"], errors="coerce").fillna(0).astype("int8")

    df = df.sort_values(["series_id", "date"]).drop_duplicates(["series_id", "date"])
    df = df.reset_index(drop=True)
    return df
