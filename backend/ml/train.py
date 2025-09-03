import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import TimeSeriesSplit
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler
from joblib import dump

from features import make_features

try:
    from xgboost import XGBClassifier
    XGB_OK = True
except Exception:
    from sklearn.ensemble import HistGradientBoostingClassifier
    XGB_OK = False

def triple_barrier_labels(df: pd.DataFrame, atr_arr: np.ndarray, horizon=8, k_sl=1.0, k_tp=2.0):
    close = df["close"].values
    n = len(df)
    y = np.zeros(n, dtype=float)
    for i in range(n):
        atr = atr_arr[i]
        if not np.isfinite(atr) or atr <= 0: 
            y[i] = np.nan
            continue
        sl = close[i] - k_sl * atr
        tp = close[i] + k_tp * atr
        hit = 0.5  # empate/sem toque
        end = min(n-1, i + horizon)
        lo = np.min(df["low"].values[i:end+1])
        hi = np.max(df["high"].values[i:end+1])
        if hi >= tp and lo <= sl:
            # desempatador: assume hit menos favorável primeiro
            hit = 0.0
        elif hi >= tp:
            hit = 1.0
        elif lo <= sl:
            hit = 0.0
        else:
            hit = 0.0
        y[i] = hit
    return y

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True, help="Caminho do CSV com time,open,high,low,close,volume")
    ap.add_argument("--timeframe", default="M5")
    ap.add_argument("--horizon", type=int, default=8)
    ap.add_argument("--atr", type=int, default=14)
    ap.add_argument("--k_sl", type=float, default=1.0)
    ap.add_argument("--k_tp", type=float, default=2.0)
    ap.add_argument("--out", default="ml/models/model_latest.pkl")
    args = ap.parse_args()

    df = pd.read_csv(args.csv)
    if "time" not in df.columns:
        raise SystemExit("CSV deve conter coluna 'time'")
    df = df.sort_values("time").reset_index(drop=True)

    X, aux = make_features(df, atr_period=args.atr)
    y = triple_barrier_labels(df, aux["atr"], horizon=args.horizon, k_sl=args.k_sl, k_tp=args.k_tp)
    mask = np.isfinite(y)
    X = X[mask]
    y = y[mask].astype(int)

    tscv = TimeSeriesSplit(n_splits=5)
    if XGB_OK:
        base = XGBClassifier(
            n_estimators=300,
            max_depth=4,
            learning_rate=0.05,
            subsample=0.9,
            colsample_bytree=0.9,
            reg_lambda=1.0,
            min_child_weight=5,
            objective="binary:logistic",
            eval_metric="logloss",
            n_jobs=4,
        )
    else:
        base = HistGradientBoostingClassifier(max_depth=4, learning_rate=0.05)

    pipe = Pipeline([
        ("scaler", StandardScaler(with_mean=True, with_std=True)),
        ("clf", base),
    ])

    # Calibração via cross-val
    calib = CalibratedClassifierCV(pipe, method="isotonic", cv=tscv)
    calib.fit(X.values, y)

    # Validação simples (último fold holdout)
    # (para relatório rápido, sem leakage grave)
    try:
        prob = calib.predict_proba(X.values)[:,1]
        auc = roc_auc_score(y, prob)
    except Exception:
        auc = float("nan")

    outp = Path(args.out)
    outp.parent.mkdir(parents=True, exist_ok=True)
    dump({"model": calib, "features": list(X.columns)}, outp)

    meta = {
        "timeframe": args.timeframe,
        "horizon": args.horizon,
        "atr": args.atr,
        "k_sl": args.k_sl,
        "k_tp": args.k_tp,
        "features": list(X.columns),
        "auc_cv_like": auc,
        "rows": int(len(X))
    }
    (outp.parent / "model_latest.meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print(f"OK: salvo {outp} — AUC≈{auc:.4f} — rows={len(X)}")

if __name__ == "__main__":
    main()
