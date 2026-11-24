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

from strategy_analysis import DB_NAME, load_settled, apply_view, _months_span, _cluster_se, Z

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

# The model refuses to fit below this many settled bets in the view.
MODEL_FLOOR = 60

# Walk-forward folds: the model is fit on the past and validated on the future,
# repeatedly, so every settled bet is finally used for validation (no 40%-only
# single holdout). The most-recent fold stays the displayed "holdout".
N_FOLDS = 5


def _add_features(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["log_odds"] = np.log(df["danske_odds"])
    df["is_favorite"] = (df["handicap"].fillna(0) < 0).astype(int)
    return df


def _walk_forward_assign(df: pd.DataFrame, n_folds: int = N_FOLDS) -> pd.DataFrame:
    """Stamp each row with a chronological fold index 0..n_folds-1 (0 = oldest),
    grouping by game so a game's rows never straddle the train/holdout boundary.
    Folds are carved on the *games* (by commence_time), then mapped back to rows."""
    df = df.copy()
    if "game_id" not in df.columns:
        df["game_id"] = df.groupby(["match_name", "commence_time"], sort=False).ngroup()
    game_order = (
        df.sort_values(["commence_time", "timestamp"])
        .drop_duplicates("game_id")[["game_id"]]
        .reset_index(drop=True)
    )
    k = min(n_folds, len(game_order))
    game_order["fold"] = pd.qcut(np.arange(len(game_order)), k, labels=False).astype(int)
    return df.merge(game_order, on="game_id", how="left")


def _pick_folds(n: int, n_folds: int = N_FOLDS, min_holdout: int = 20, min_train: int = 40):
    """Largest fold count that keeps every trailing holdout and its train set big
    enough. Returns None when even 3 folds can't be formed (sample too small)."""
    k = n_folds
    while k > 2 and (n / k < min_holdout or n * (k - 1) / k < min_train):
        k -= 1
    return k if k >= 3 else None


def build_model(
    dedup: str = "match_selection",
    min_ev: float = 0.0,
    max_ev: float = 1e9,
    min_minutes: float = 0.0,
    max_minutes: float = 1e9,
    min_odds: float = 1.0,
    max_odds: float = 1e9,
    league: str | None = None,
    market: str = "All",
) -> dict:
    base = {"available": SKLEARN_AVAILABLE, "market": market if market != "All" else "all"}
    if not SKLEARN_AVAILABLE:
        return base

    df = _add_features(load_settled(league=league, market=market))
    used, meta = apply_view(df, dedup, min_ev, max_ev, min_minutes, max_minutes, min_odds, max_odds)
    # Money-line bets have no handicap, so |handicap| is NaN — the model can't use
    # them. Drop feature-incomplete rows before the floor check.
    used = used.dropna(subset=FEATURES)
    meta["n_used"] = len(used)
    meta["floor"] = MODEL_FLOOR
    if len(used) < MODEL_FLOOR:
        return {**base, "error": f"Need ≥ {MODEL_FLOOR} settled bets in this view to fit the model.", "meta": meta}

    # Walk-forward: stamp chronological folds, report pooled out-of-sample log_loss
    # over every validation fold, and use the most recent fold as the display holdout.
    K = _pick_folds(len(used))
    if K is None:
        return {**base, "error": "Too few settled bets to form valid walk-forward folds.", "meta": meta}
    used = _walk_forward_assign(used, K)
    K = int(used["fold"].nunique())
    X = FEATURES

    def _lr_pipe():
        return Pipeline([
            ("scale", StandardScaler()),
            ("model", LogisticRegression(max_iter=2000, C=1.0, random_state=42)),
        ])

    # --- 1. Pooled walk-forward log_loss (honest out-of-sample read) ---
    fold = {"baseline": [], "logistic": [], "gbm": []}
    for k in range(1, K):
        tr = used[used["fold"] < k]
        ho = used[used["fold"] == k]
        if len(tr) < 40 or len(ho) < 20:
            continue
        p = _lr_pipe()
        p.fit(tr[X], tr["won"])
        prob = p.predict_proba(ho[X])[:, 1]
        bp = float(tr["won"].mean())
        fold["baseline"].append(float(log_loss(ho["won"], [bp] * len(ho))))
        fold["logistic"].append(float(log_loss(ho["won"], prob)))
        try:
            gbm = GradientBoostingClassifier(
                n_estimators=120, max_depth=3, learning_rate=0.05, random_state=42
            )
            gbm.fit(tr[X], tr["won"])
            fold["gbm"].append(float(log_loss(ho["won"], gbm.predict_proba(ho[X])[:, 1])))
        except Exception:
            pass
    if not fold["logistic"]:
        return {**base, "error": "Too few bets to form valid walk-forward folds.", "meta": meta}
    baseline_ll = round(float(np.mean(fold["baseline"])), 4)
    lr_ll = round(float(np.mean(fold["logistic"])), 4)
    gbm_ll = round(float(np.mean(fold["gbm"])), 4) if fold["gbm"] else None

    # --- 2. Final model trained on all but the last fold (display) ---
    last = K - 1
    dtr = used[used["fold"] < last]
    dho = used[used["fold"] == last]
    pipe_lr = _lr_pipe()
    pipe_lr.fit(dtr[X], dtr["won"])
    hold_prob_lr = pipe_lr.predict_proba(dho[X])[:, 1]
    base_prob = float(dtr["won"].mean())
    lr_coefs = pipe_lr.named_steps["model"].coef_[0]

    # --- 3. CLV regression (diagnostic target ≈ true long-run edge) ---
    clv_train = dtr.dropna(subset=["clv_pct"])
    clv_hold = dho.dropna(subset=["clv_pct"])
    clv_r2 = None
    clv_coefs = [None] * len(X)
    if len(clv_train) >= 60 and len(clv_hold) >= 10:
        pipe_clr = Pipeline([("scale", StandardScaler()), ("model", LinearRegression())])
        pipe_clr.fit(clv_train[X], clv_train["clv_pct"])
        clv_pred = pipe_clr.predict(clv_hold[X])
        clv_r2 = float(r2_score(clv_hold["clv_pct"], clv_pred))
        clv_coefs = pipe_clr.named_steps["model"].coef_

    # --- 4. Decile calibration of the model ranking on the final holdout ---
    hold = dho.copy()
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
            "validation_method": "walk_forward",
            "folds": K,
            "cutoff": dho["timestamp"].min().strftime("%Y-%m-%d"),
            "train_n": len(dtr),
            "holdout_n": len(dho),
        },
        "holdout": {
            "n": len(dho),
            "wins": int(dho["won"].sum()),
            "win_rate": round(float(dho["won"].mean() * 100.0), 1),
            "roi": round(float(dho["profit"].mean() * 100.0), 2),
            "bets_per_month": round(len(dho) / max(_months_span(dho), 0.1), 1),
            "months": round(float(_months_span(dho)), 1),
        },
        "model": {
            "train_win_rate": round(base_prob * 100.0, 1),
            "baseline_log_loss": baseline_ll,
            "logistic_log_loss": lr_ll,
            "gbm_log_loss": gbm_ll,
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
    min_n: int = 5,
    league: str | None = None,
    market: str = "All",
) -> dict:
    """Bets/month vs ROI frontier over (min EV × min hours) rules, evaluated on the
    pooled walk-forward validation folds (every settled bet serves as a holdout)."""
    base = {"available": SKLEARN_AVAILABLE, "market": market if market != "All" else "all"}
    if not SKLEARN_AVAILABLE:
        return base

    df = _add_features(load_settled(league=league, market=market))
    used, meta = apply_view(
        df, dedup, max_ev=max_ev, max_minutes=max_hours * 60.0,
        min_odds=min_odds, max_odds=max_odds,
    )
    meta["floor"] = MODEL_FLOOR
    if len(used) < MODEL_FLOOR:
        return {**base, "error": f"Need ≥ {MODEL_FLOOR} settled bets in this view to sweep rules.", "meta": meta}

    K = _pick_folds(len(used))
    if K is None:
        return {**base, "error": "Too few settled bets to form valid walk-forward folds.", "meta": meta}
    used = _walk_forward_assign(used, K)
    val = used[used["fold"] > 0]  # pooled validation folds (everything except the oldest)
    K = int(used["fold"].nunique())
    months = max(float(_months_span(val)), 0.1)

    rows = []
    for ev in ev_grid:
        if ev > max_ev:
            continue
        for h in hours_grid:
            if h > max_hours:
                continue
            sub = val[(val["ev_percent"] >= ev) & (val["hours_to_start"] >= h)]
            if len(sub) < min_n:
                continue
            roi = float(sub["profit"].mean() * 100.0)
            if len(sub) > 1 and "game_id" in sub.columns and sub["game_id"].nunique() > 1:
                se = _cluster_se(sub["profit"].values, sub["game_id"].values, len(sub))
            else:
                se = sub["profit"].std(ddof=1) / math.sqrt(len(sub)) if len(sub) > 1 else 0.0
            ci = float(Z * se * 100.0)
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
            "validation_method": "walk_forward",
            "folds": K,
            "cutoff": val["timestamp"].min().strftime("%Y-%m-%d"),
            "train_n": int((used["fold"] == 0).sum()),
            "holdout_n": len(val),
            "months": round(months, 1),
        },
        "rows": rows,
    }


if __name__ == "__main__":
    import json

    print(json.dumps(build_model(), indent=1, default=str))
    print(json.dumps(build_sweep(), indent=1, default=str))