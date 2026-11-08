"""Download the public datasets and record provenance.

FreshRetailNet-50K is downloaded directly from Hugging Face (CC BY 4.0).
The M5 competition data requires a Kaggle account to accept the competition
rules, so the official competition CSV files are fetched from a public
Hugging Face mirror; the official Kaggle URL is recorded in the manifest.
"""

from __future__ import annotations

import argparse
import hashlib
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from ml.config import (
    ARTIFACTS,
    FRESH_EVAL,
    FRESH_RAW_DIR,
    FRESH_TRAIN,
    M5_CALENDAR,
    M5_PRICES,
    M5_RAW_DIR,
    M5_SALES,
    REPO_ROOT,
)
from ml.pipeline.jsonutil import write_json

FRESH_BASE = "https://huggingface.co/datasets/THULab/freshretailnet_50k/resolve/main"
M5_BASE = "https://huggingface.co/datasets/denephew/M5_Forecasting/resolve/main"

FILES = [
    {
        "path": FRESH_TRAIN,
        "url": f"{FRESH_BASE}/freshretailnet_50k_train.tsfile",
        "dataset": "freshretailnet",
        "license": "CC BY 4.0",
        "official_source": "https://huggingface.co/datasets/THULab/freshretailnet_50k",
    },
    {
        "path": FRESH_EVAL,
        "url": f"{FRESH_BASE}/freshretailnet_50k_eval.tsfile",
        "dataset": "freshretailnet",
        "license": "CC BY 4.0",
        "official_source": "https://huggingface.co/datasets/THULab/freshretailnet_50k",
    },
    {
        "path": M5_CALENDAR,
        "url": f"{M5_BASE}/calendar.csv",
        "dataset": "m5",
        "license": "Kaggle competition terms",
        "official_source": "https://www.kaggle.com/competitions/m5-forecasting-accuracy/data",
    },
    {
        "path": M5_SALES,
        "url": f"{M5_BASE}/sales_train_evaluation.csv",
        "dataset": "m5",
        "license": "Kaggle competition terms",
        "official_source": "https://www.kaggle.com/competitions/m5-forecasting-accuracy/data",
    },
    {
        "path": M5_PRICES,
        "url": f"{M5_BASE}/sell_prices.csv",
        "dataset": "m5",
        "license": "Kaggle competition terms",
        "official_source": "https://www.kaggle.com/competitions/m5-forecasting-accuracy/data",
    },
]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(url: str, destination: Path, force: bool = False) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() and destination.stat().st_size > 0 and not force:
        print(f"[download] exists: {destination} ({destination.stat().st_size:,} bytes)", flush=True)
        return
    temp = destination.with_suffix(destination.suffix + ".part")
    print(f"[download] {url}", flush=True)
    with urllib.request.urlopen(url, timeout=120) as response, temp.open("wb") as handle:
        total = int(response.headers.get("Content-Length") or 0)
        written = 0
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            handle.write(chunk)
            written += len(chunk)
            if total and written % (100 * 1024 * 1024) < 1024 * 1024:
                print(f"  {written / 1e6:.0f}/{total / 1e6:.0f} MB", flush=True)
    temp.replace(destination)
    print(f"[download] saved {destination} ({destination.stat().st_size:,} bytes)", flush=True)


def main(argv=None) -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args(argv)

    FRESH_RAW_DIR.mkdir(parents=True, exist_ok=True)
    M5_RAW_DIR.mkdir(parents=True, exist_ok=True)
    ARTIFACTS.mkdir(parents=True, exist_ok=True)

    manifest = {"downloaded_at": datetime.now(timezone.utc).isoformat(), "files": []}
    for entry in FILES:
        download(entry["url"], entry["path"], force=args.force)
        manifest["files"].append(
            {
                **entry,
                "path": str(entry["path"].relative_to(REPO_ROOT)).replace("\\", "/"),
                "bytes": entry["path"].stat().st_size,
                "sha256": sha256(entry["path"]),
            }
        )
    out = ARTIFACTS / "dataset_manifest.json"
    write_json(out, manifest)
    print(f"[download] wrote {out}", flush=True)


if __name__ == "__main__":
    main()
