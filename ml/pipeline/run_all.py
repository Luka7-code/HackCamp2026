"""Run the full dataset -> adapter -> training -> app-mapping pipeline.

Usage (from the repository root):
    python ml/pipeline/run_all.py
    python ml/pipeline/run_all.py --skip-download --force-build
"""

from __future__ import annotations

import argparse

import pandas as pd

from ml.config import (
    FRESH_EVAL_PROCESSED,
    FRESH_PROCESSED,
    M5_PROCESSED,
    METRICS,
)
from ml.pipeline import build_dataset, download_datasets, map_to_app, patterns, train


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-download", action="store_true")
    parser.add_argument("--skip-build", action="store_true")
    parser.add_argument("--skip-train", action="store_true")
    parser.add_argument("--skip-map", action="store_true")
    parser.add_argument("--force-build", action="store_true")
    args = parser.parse_args()

    if not args.skip_download:
        download_datasets.main([])

    if not args.skip_build:
        build_dataset.build(force=args.force_build)

    fresh_train = pd.read_parquet(FRESH_PROCESSED)
    fresh_eval = pd.read_parquet(FRESH_EVAL_PROCESSED)
    m5 = pd.read_parquet(M5_PROCESSED)

    if not args.skip_train:
        results = []
        print("[train] FreshRetailNet ...", flush=True)
        results.append(train.train_dataset("freshretailnet", fresh_train, fresh_eval))
        train.save_metrics(results, METRICS)

        print("[train] M5 ...", flush=True)
        results.append(train.train_dataset("m5", m5))
        train.save_metrics(results, METRICS)
        print(f"[train] wrote {METRICS}", flush=True)

        all_patterns = patterns.select_patterns(fresh_train, "freshretailnet") + patterns.select_patterns(
            m5, "m5"
        )
        patterns.save_patterns(all_patterns)
        print(f"[patterns] wrote {len(all_patterns)} patterns", flush=True)

    if not args.skip_map:
        map_to_app.run()

    print("[done] pipeline complete", flush=True)


if __name__ == "__main__":
    main()
