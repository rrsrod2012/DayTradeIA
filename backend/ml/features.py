import numpy as np
import pandas as pd

def ema(arr, period):
    arr = np.asarray(arr, dtype=float)
    alpha = 2.0 / (period + 1.0)
    out = np.empty_like(arr)
    ema_val = arr[0]
    for i, v in enumerate(arr):
        ema_val = alpha * v + (1 - alpha) * ema_val if i else v
        out[i] = ema_val
    return out

def atr(high, low, close, period=14):
    high, low, close = map(lambda x: np.asarray(x, dtype=float), (high, low, close))
    prev_close = np.roll(close, 1)
    prev_close[0] = close[0]
    tr = np.maximum(high - low, np.maximum(np.abs(high - prev_close), np.abs(low - prev_close)))
    # Wilder style
    atr_vals = np.empty_like(tr)
    atr_vals[:] = np.nan
    atr_vals[period-1] = tr[:period].mean()
    for i in range(period, len(tr)):
        atr_vals[i] = (atr_vals[i-1]*(period-1) + tr[i]) / period
    return atr_vals

def vwap_daily(df: pd.DataFrame, tz="America/Sao_Paulo"):
    # Anchored VWAP por dia (reinicia a cada data local)
    local_date = pd.to_datetime(df["time"]).dt.tz_localize("UTC", nonexistent="shift_forward", ambiguous="NaT").dt.tz_convert(tz).dt.date
    out = np.full(len(df), np.nan, dtype=float)
    for d in np.unique(local_date):
        idx = np.where(local_date == d)[0]
        tp = (df["high"].values[idx] + df["low"].values[idx] + df["close"].values[idx]) / 3.0
        vol = np.where(pd.isna(df["volume"].values[idx]), 1.0, df["volume"].values[idx].astype(float))
        cum_pv = np.cumsum(tp * vol)
        cum_v = np.cumsum(vol)
        out[idx] = cum_pv / np.maximum(1e-9, cum_v)
    return out

def make_features(df: pd.DataFrame, atr_period=14):
    df = df.copy()
    e9 = ema(df["close"].values, 9)
    e21 = ema(df["close"].values, 21)
    _atr = atr(df["high"].values, df["low"].values, df["close"].values, period=atr_period)
    vwap = vwap_daily(df)

    # Backfill mínimos
    for arr in (e9, e21, _atr, vwap):
        mask = np.isnan(arr)
        if mask.any():
            arr[mask] = pd.Series(arr).fillna(method="ffill").fillna(method="bfill").values[mask]

    prev_close = np.r_[df["close"].values[0], df["close"].values[:-1].values]
    ret1 = (df["close"].values - prev_close) / np.maximum(1e-6, _atr)
    slope9 = np.r_[0.0, np.diff(e9)]
    slope21 = np.r_[0.0, np.diff(e21)]

    X = pd.DataFrame({
        "dist_ema21": (df["close"].values - e21) / np.maximum(1e-6, _atr),
        "dist_vwap": (df["close"].values - vwap) / np.maximum(1e-6, _atr),
        "slope_e9": slope9 / np.maximum(1e-6, _atr),
        "slope_e21": slope21 / np.maximum(1e-6, _atr),
        "range_ratio": (df["high"].values - df["low"].values) / np.maximum(1e-6, _atr),
        "ret1": ret1,
        "hour": pd.to_datetime(df["time"]).dt.hour.astype(float).values,
    })
    aux = {"e9": e9, "e21": e21, "atr": _atr, "vwap": vwap}
    return X, aux
