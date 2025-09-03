from fastapi import FastAPI
from pydantic import BaseModel
from joblib import load
import numpy as np

app = FastAPI(title="daytrade-ia micro model", version="1.0.0")

ARTIFACT = "ml/models/model_latest.pkl"
PKL = None
FEATURES = None

class PredictIn(BaseModel):
    features: dict

@app.on_event("startup")
def _load():
    global PKL, FEATURES
    PKL = load(ARTIFACT)
    FEATURES = PKL.get("features", None)

@app.post("/predict")
def predict(inp: PredictIn):
    if PKL is None:
        return {"p": 0.5}
    feats = inp.features or {}
    cols = FEATURES or list(feats.keys())
    x = [feats.get(k, 0.0) for k in cols]
    prob = PKL["model"].predict_proba(np.asarray([x]))[0,1]
    # hard clamp
    prob = max(0.0, min(1.0, float(prob)))
    return {"p": prob}

@app.get("/healthz")
def health():
    return {"ok": True, "loaded": PKL is not None}
