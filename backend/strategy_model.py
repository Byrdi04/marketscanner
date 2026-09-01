"""
Strategy Model & Threshold Sweep (Phase 2 + 3)
===============================================
Phase 2: logistic regression (win/loss) + CLV regression on the
already-collected paper bets, validated on a TEMPORAL holdout (the later
slice of the timeline — training on the past, testing on the future).

Phase 3: threshold sweep producing the "bets/month vs ROI" frontier,
evaluated on the same holdout.

Constraint: uses ONLY data already in `paper_bets` — no new API credits.
"""

import math

import numpy as np
import pandas as pd

from strategy_analysis import DB_NAME, load_settled, apply_view, _months_span, Z

SKLEARN_AVAILABLE = False
try:
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import StandardScaler
    from sklearn.linear_model import LogisticRegression, LinearRegression
    from sklearn.ensemble import GradientBoostingClassifier
    from sklearn.metrics import log_loss, r2_score
    SKLEARN_AVAILABLE = True
except Exception:
    pass

# Features for the win/loss model (≤6, chosen from the plan section 2)
FEATURES = ["ev_percent", "log_odds", "hours_to_start", "abs_handicap", "is_favorite"]
FEATURE_LABELS = {
    "ev_percent": "EV %",
    "log_odds": "log(odds) — odds magnitude",
    "hours_to_start": "Hours to start",
    "abs_handicap": "|Handicap| (pts)",
    "is_favorite": "Favourite (neg. handicap)",
}

# First 60% of the timeline = train, later 40% = holdout
SPLIT_FRACTION = 0.6


def _add_features(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["log_odds"] = np.log(df["danske_odds"])
    df["is_favorite"] = (df["handicap"].fillna(0) < 0).astype(int)
    return df


def temporal_split(df: pd.DataFrame, split_frac: float = SPLIT_FRACTION):
    """Chronological split: train on the past, holdout on the future."""
    df = df.sort_values("timestamp").reset_index(drop=True)
    cutoff = df["timestamp"].quantile(split_frac)
    train = df[df["timestamp"] <= cutoff]
    holdout = df[df["timestamp"] > cutoff]
    return train, holdout, cutoff


def build_model(
    dedup: str = "match_selection",
    min_ev: float = 0.0,
    max_ev: float = 1e9,
    min_minutes: float = 0.0,
    max_minutes: float = 1e9,
    min_odds: float = 1.0,
    max_odds: float = 1e9,
) -> dict:
    base = {"available": SKLEARN_AVAILABLE}
    if not SKLEARN_AVAILABLE:
        return base

    df = _add_features(load_settled())
    used, meta = apply_view(df, dedup, min_ev, max_ev, min_minutes, max_minutes, min_odds, max_odds)
    if len(used) < 60:
        return {**base, "error": "Need ≥ 60 settled bets in this view to fit the model.", "meta": meta}

    train, holdout, cutoff = temporal_split(used)
    if len(train) < 40 or len(holdout) < 20:
        return {**base, "error": "Too few bets in train/holdout after the time split.", "meta": meta}

    X = FEATURES
    y = train["won"]

    # --- 1. Logistic regression (primary) ---
    pipe_lr = Pipeline([
        ("scale", StandardScaler()),
        ("model", LogisticRegression(max_iter=2000, C=1.0, random_state=42)),
    ])
    pipe_lr.fit(train[X], y)
    hold_prob_lr = pipe_lr.predict_proba(holdout[X])[:, 1]

    base_prob = float(train["won"].mean())
    baseline_ll = float(log_loss(holdout["won"], [base_prob] * len(holdout)))
    lr_ll = float(log_loss(holdout["won"], hold_prob_lr))
    lr_coefs = pipe_lr.named_steps["model"].coef_[0]

    # --- 2. GBM cross-check (does fancier ML beat the logistic rule?) ---
    gbm_ll = None
    try:
        gbm = GradientBoostingClassifier(
            n_estimators=120, max_depth=3, learning_rate=0.05, random_state=42
        )
        gbm.fit(train[X], y)
        gbm_ll = float(log_loss(holdout["won"], gbm.predict_proba(holdout[X])[:, 1]))
    except Exception:
        pass

    # --- 3. CLV regression (diagnostic target ≈ true long-run edge) ---
    clv_train = train.dropna(subset=["clv_pct"])
    clv_hold = holdout.dropna(subset=["clv_pct"])
    clv_r2 = None
    clv_coefs = [None] * len(X)
    if len(clv_train) >= 60 and len(clv_hold) >= 10:
        pipe_clr = Pipeline([("scale", StandardScaler()), ("model", LinearRegression())])
        pipe_clr.fit(clv_train[X], clv_train["clv_pct"])
        clv_pred = pipe_clr.predict(clv_hold[X])
        clv_r2 = float(r2_score(clv_hold["clv_pct"], clv_pred))
        clv_coefs = pipe_clr.named_steps["model"].coef_

    # --- 4. Decile calibration of the model ranking on the holdout ---
    hold = holdout.copy()
    hold["pred"] = hold_prob_lr
    deciles = []
    try:
        bands = pd.qcut(hold["pred"], q=10, duplicates="drop")
    except ValueError:
        try:
            bands = pd.qcut(hold["pred"], q=5, duplicates="drop")
        except ValueError:
            bands = None
    if bands is not None:
        for i, (_label, g) in enumerate(hold.groupby(bands, observed=True), start=1):
            n = len(g)
            if n < 3:
                continue
            deciles.append({
                "decile": i,
                "band": f"{_label.left:.3f}–{_label.right:.3f}",
                "n": n,
                "win_rate": round(float(g["won"].mean() * 100.0), 1),
                "roi": round(float(g["profit"].mean() * 100.0), 2),
            })

    return {
        **base,
        "meta": {
            **meta,
            "split_fraction": SPLIT_FRACTION,
            "cutoff": cutoff.strftime("%Y-%m-%d"),
            "train_n": len(train),
            "holdout_n": len(holdout),
        },
        "holdout": {
            "n": len(holdout),
            "wins": int(holdout["won"].sum()),
            "win_rate": round(float(holdout["won"].mean() * 100.0), 1),
            "roi": round(float(holdout["profit"].mean() * 100.0), 2),
            "bets_per_month": round(len(holdout) / max(_months_span(holdout), 0.1), 1),
            "months": round(float(_months_span(holdout)), 1),
        },
        "model": {
            "train_win_rate": round(base_prob * 100.0, 1),
            "baseline_log_loss": round(baseline_ll, 4),
            "logistic_log_loss": round(lr_ll, 4),
            "gbm_log_loss": round(gbm_ll, 4) if gbm_ll is not None else None,
        },
        "coefficients": [
            {
                "feature": f,
                "label": FEATURE_LABELS.get(f, f),
                "win_coef": round(float(lr_coefs[i]), 3),
                "clv_coef": round(float(clv_coefs[i]), 3) if clv_coefs[i] is not None else None,
            }
            for i, f in enumerate(X)
        ],
        "clv_model": {
            "r2": round(clv_r2, 3) if clv_r2 is not None else None,
            "n_train": len(clv_train),
            "n_holdout": len(clv_hold),
        },
        "deciles": deciles,
    }


def build_sweep(
    dedup: str = "match_selection",
    max_ev: float = 1e9,
    max_hours: float = 1e9,
    min_odds: float = 1.0,
    max_odds: float = 1e9,
    ev_grid=(0.0, 0.5, 1.0, 2.0, 3.0, 5.0),
    hours_grid=(0.0, 3.0, 6.0, 12.0),
    split_frac: float = SPLIT_FRACTION,
    min_n: int = 5,
) -> dict:
    """Bets/month vs ROI frontier over (min EV × min hours) rules, holdout-only."""
    base = {"available": SKLEARN_AVAILABLE}
    if not SKLEARN_AVAILABLE:
        return base

    df = _add_features(load_settled())
    used, meta = apply_view(
        df, dedup, max_ev=max_ev, max_minutes=max_hours * 60.0,
        min_odds=min_odds, max_odds=max_odds,
    )
    train, holdout, cutoff = temporal_split(used, split_frac)
    months = max(float(_months_span(holdout)), 0.1)

    rows = []
    for ev in ev_grid:
        if ev > max_ev:
            continue
        for h in hours_grid:
            if h > max_hours:
                continue
            sub = holdout[(holdout["ev_percent"] >= ev) & (holdout["hours_to_start"] >= h)]
            if len(sub) < min_n:
                continue
            roi = float(sub["profit"].mean() * 100.0)
            ci = float(Z * sub["profit"].std(ddof=1) / math.sqrt(len(sub)) * 100.0) if len(sub) > 1 else 0.0
            rows.append({
                "rule": f"EV ≥ {ev:g}% · T ≥ {h:g}h",
                "min_ev": ev,
                "min_hours": h,
                "n": len(sub),
                "wins": int(sub["won"].sum()),
                "roi": round(roi, 2),
                "ci_low": round(roi - ci, 2),
                "ci_high": round(roi + ci, 2),
                "bets_per_month": round(len(sub) / months, 1),
            })

    return {
        **base,
        "meta": {
            "dedup": dedup,
            "cutoff": cutoff.strftime("%Y-%m-%d"),
            "train_n": len(train),
            "holdout_n": len(holdout),
            "months": round(months, 1),
        },
        "rows": rows,
    }


if __name__ == "__main__":
    import json

    print(json.dumps(build_model(), indent=1, default=str))
    print(json.dumps(build_sweep(), indent=1, default=str))