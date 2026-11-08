"""Shared configuration for the predictive-AI ML pipeline.

Raw public datasets are kept separate from processed training data:

    ml/data/raw/         downloaded public datasets (git-ignored)
    ml/data/processed/   standardized parquet files (git-ignored)
    ml/artifacts/        small JSON artifacts consumed by the Node backend
    ml/artifacts/models/ trained model files (git-ignored, reproducible)
"""

from pathlib import Path

ML_ROOT = Path(__file__).resolve().parent
REPO_ROOT = ML_ROOT.parent

DATA_RAW = ML_ROOT / "data" / "raw"
DATA_PROCESSED = ML_ROOT / "data" / "processed"
ARTIFACTS = ML_ROOT / "artifacts"
MODELS = ARTIFACTS / "models"

FRESH_RAW_DIR = DATA_RAW / "freshretailnet"
M5_RAW_DIR = DATA_RAW / "m5"

FRESH_TRAIN = FRESH_RAW_DIR / "freshretailnet_50k_train.tsfile"
FRESH_EVAL = FRESH_RAW_DIR / "freshretailnet_50k_eval.tsfile"

M5_SALES = M5_RAW_DIR / "sales_train_evaluation.csv"
M5_CALENDAR = M5_RAW_DIR / "calendar.csv"
M5_PRICES = M5_RAW_DIR / "sell_prices.csv"

FRESH_PROCESSED = DATA_PROCESSED / "freshretailnet.parquet"
FRESH_EVAL_PROCESSED = DATA_PROCESSED / "freshretailnet_eval.parquet"
M5_PROCESSED = DATA_PROCESSED / "m5.parquet"
APP_INVENTORY = DATA_PROCESSED / "app_inventory.json"

DATASET_REPORT = ARTIFACTS / "dataset_report.json"
METRICS = ARTIFACTS / "metrics.json"
DEMAND_PATTERNS = ARTIFACTS / "demand_patterns.json"
APP_FORECASTS = ARTIFACTS / "app_forecasts.json"

SEED = 42

# Keep training tractable on a laptop while still covering thousands of series.
FRESH_TRAIN_SERIES = 2000
FRESH_EVAL_SERIES = 800
M5_TRAIN_SERIES = 2000

HISTORY_DAYS = 90
TEST_DAYS = 30
FORECAST_HORIZON = 30

FRESH_DATASET = {
    "dataset_id": "freshretailnet",
    "display_name": "FreshRetailNet-50K",
    "source_url": "https://huggingface.co/datasets/THULab/freshretailnet_50k",
    "license": "CC BY 4.0",
    "notes": (
        "50,000 store-product 90-day series from 898 stores in 18 Chinese cities. "
        "sale_amount is a globally normalized sales amount, used as the demand "
        "target; stock_hour6_22_cnt provides organic stockout labels."
    ),
}

M5_DATASET = {
    "dataset_id": "m5",
    "display_name": "M5 Walmart Forecasting (Accuracy)",
    "source_url": "https://www.kaggle.com/competitions/m5-forecasting-accuracy/data",
    "license": "Kaggle competition terms (public data)",
    "notes": (
        "Official competition files mirrored on Hugging Face because the Kaggle "
        "API requires an authenticated account. Daily unit sales, calendar "
        "events/SNAP days and sell prices are used. M5 has no stockout labels."
    ),
}

DATASETS = [FRESH_DATASET, M5_DATASET]

# Configurable demand levels used to scale dataset patterns onto the
# warehouse's unit-level inventory when operational history is insufficient.
APP_TARGET_DAILY_DEMAND = [
    0.45,
    0.03,
    0.35,
    0.0015,
    0.25,
    0.001,
    0.18,
    0.02,
    0.55,
    0.0008,
]
