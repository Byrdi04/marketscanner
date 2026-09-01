"""
Strategy Analysis — Evidence Tables (Phase 0 + 1)
==================================================
Computes the feature dataset and evidence tables for finding where the
paper-trading EV estimate is systematically right/wrong.

Constraint: uses ONLY data already collected in `paper_bets`.
No Pinnacle API credits, no new data collection.

Features per settled bet (unit stake):
  * profit        = (odds - 1) if Won else -1            [ROI base]
  * minutes_start = commence_time - timestamp            [time before start]
  * clv_pct       = (danske_odds / closing_odds - 1) * 100  [CLV, when known]
  * implied_p     = 1 / pinnacle_odds                    [calibration]

Evidence tables (each: n, win_rate, roi, 95% CI, bets/month, avg CLV):
  * ROI by EV magnitude
  * ROI by time-to-start (hours)
  * ROI by odds magnitude (decimal odds level)
  * ROI by handicap (abs pts)
  * ROI by CLV
  * Calibration: Pinnacle implied prob vs realized win rate
"""

import sqlite3
import math
from datetime import datetime, timezone

import numpy as np
import pandas as pd

DB_NAME = "data/bets.db"

# --- Bin definitions (chosen from the actual data distribution) ---
EV_EDGES = [0.5, 1, 2, 4]
EV_LABELS = ["0–0.5%", "0.5–1%", "1–2%", "2–4%", ">4%"]

TIME_EDGES_H = [3, 6, 12]
TIME_LABELS = ["<3h", "3–6h", "6–12h", "12–24h"]

# Settled odds levels are 1.93/1.95/1.98/2.00/2.05/2.10(+). Split at
# the real price points so each bin is one odds level.
ODDS_EDGES = [1.99, 2.001, 2.051]
ODDS_LABELS = ["<2.00", "2.00", "2.05", ">2.05"]

HANDICAP_EDGES = [4.5, 7.5, 10.5]
HANDICAP_LABELS = ["≤4.5", "5–7.5", "8–10.5", "≥11"]

CLV_EDGES = [0, 1, 2.5, 5]
CLV_LABELS = ["<0%", "0–1%", "1–2.5%", "2.5–5%", ">5%"]

Z = 1.96  # 95% CI


def _bucket(series: pd.Series, edges, labels) -> pd.Series:
    """Bucket into (len(edges)+1) bins with labels."""
    bins = [-math.inf] + list(edges) + [math.inf]
    return pd.cut(series, bins=bins, right=False, labels=labels)


def load_settled() -> pd.DataFrame:
    """Load settled paper bets with derived features."""
    conn = sqlite3.connect(DB_NAME)
    df = pd.read_sql_query("SELECT * FROM paper_bets", conn)
    conn.close()

    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
    df["commence_time"] = pd.to_datetime(df["commence_time"], utc=True, format="mixed")

    df["settled"] = df["status"].isin(["Won", "Lost"])

    # Per-bet profit on unit stake
    df["won"] = (df["status"] == "Won").astype(int)
    df["profit"] = np.where(df["won"] == 1, df["danske_odds"] - 1.0, -1.0)

    # Minutes before game start
    df["minutes_to_start"] = (df["commence_time"] - df["timestamp"]).dt.total_seconds() / 60.0
    df["hours_to_start"] = df["minutes_to_start"] / 60.0

    # CLV (only when a closing price was captured)
    df["clv_pct"] = (df["danske_odds"] / df["closing_odds"] - 1.0) * 100.0

    # Pinnacle fair implied probability (1 / fair price)
    df["implied_p"] = 1.0 / df["pinnacle_odds"]

    # |handicap| — spread size as favorite/dog margin
    df["abs_handicap"] = df["handicap"].abs()

    return df


def apply_view(
    df: pd.DataFrame,
    dedup: str = "match_selection",
    min_ev: float = 0.0,
    min_minutes: float = 0.0,
    max_minutes: float = 1e9,
    min_odds: float = 1.0,
    max_odds: float = 1e9,
):
    """Return (used_df, meta) with dedup + threshold filters applied."""
    total_logged = len(df)
    n_pending = int((~df["settled"]).sum())

    used = df[df["settled"]].copy()
    n_settled = len(used)

    dropped_dupes = 0
    if dedup == "match_selection":
        before = len(used)
        # Earliest logged price per match + selection (+ line)
        key = ["match_name", "selection", "market_type", "handicap"]
        used = used.sort_values("timestamp").drop_duplicates(subset=key, keep="first")
        dropped_dupes = before - len(used)
    elif dedup == "game":
        before = len(used)
        used = used.sort_values("timestamp").drop_duplicates(
            subset=["match_name", "commence_time"], keep="first"
        )
        dropped_dupes = before - len(used)

    before_filter = len(used)
    used = used[
        (used["ev_percent"] >= min_ev)
        & (used["minutes_to_start"] >= min_minutes)
        & (used["minutes_to_start"] <= max_minutes)
        & (used["danske_odds"] >= min_odds)
        & (used["danske_odds"] <= max_odds)
    ].copy()
    dropped_filters = before_filter - len(used)

    return used, {
        "dedup": dedup,
        "total_logged": total_logged,
        "n_pending_excluded": n_pending,
        "n_settled": n_settled,
        "n_duplicates_excluded": dropped_dupes,
        "n_filtered_out": dropped_filters,
        "n_used": len(used),
    }


def _months_span(df: pd.DataFrame) -> float:
    if df.empty:
        return 1.0
    span_days = (df["timestamp"].max() - df["timestamp"].min()).total_seconds() / 86400.0
    return max(span_days / 30.44, 0.1)


def _roi_stats(group: pd.DataFrame) -> dict:
    n = len(group)
    if n == 0:
        return None
    profits = group["profit"].values
    roi = float(profits.mean() * 100.0)
    ci_half = float(Z * (profits.std(ddof=1) / math.sqrt(n)) * 100.0) if n > 1 else 0.0
    wins = int(group["won"].sum())
    return {
        "n": n,
        "wins": wins,
        "win_rate": round(float(wins / n * 100.0), 1),
        "roi": round(roi, 2),
        "ci_low": round(roi - ci_half, 2),
        "ci_high": round(roi + ci_half, 2),
        "avg_clv": round(float(group["clv_pct"].mean()), 2)
        if group["clv_pct"].notna().any()
        else None,
    }


def table_by(df: pd.DataFrame, col: str, edges, labels) -> list:
    """Group rows into (len(edges)+1) labels, return evidence rows with n>0."""
    if df.empty:
        return []
    bucketed = _bucket(df[col], edges, labels)
    months = _months_span(df)
    rows = []
    for label in labels:
        g = df[bucketed == label]
        if g.empty:
            continue
        stats = _roi_stats(g)
        if stats is None:
            continue
        stats["bin"] = label
        stats["bets_per_month"] = round(stats["n"] / months, 1)
        rows.append(stats)
    return rows


DIMENSIONS = [
    ("roi_by_ev", "EV %", "ev_percent", EV_EDGES, EV_LABELS),
    ("roi_by_time", "Time to start (h)", "hours_to_start", TIME_EDGES_H, TIME_LABELS),
    ("roi_by_odds", "Decimal odds", "danske_odds", ODDS_EDGES, ODDS_LABELS),
    ("roi_by_handicap", "|Handicap| (pts)", "abs_handicap", HANDICAP_EDGES, HANDICAP_LABELS),
    ("roi_by_clv", "CLV %", "clv_pct", CLV_EDGES, CLV_LABELS),
]


def calibration(df: pd.DataFrame) -> list:
    """Quantile bands of Pinnacle implied prob vs realized win rate."""
    if df.empty or df["implied_p"].nunique() < 3:
        return []
    try:
        bands = pd.qcut(df["implied_p"], q=5, duplicates="drop", retbins=False)
    except ValueError:
        return []
    rows = []
    for label, g in df.groupby(bands, observed=True):
        if len(g) < 5:
            continue
        mid = (label.left + label.right) / 2
        n = len(g)
        win_rate = float(g["won"].mean() * 100.0)
        ci_half = float(Z * math.sqrt((win_rate / 100.0) * (1 - win_rate / 100.0) / n) * 100.0)
        rows.append(
            {
                "band": f"{label.left:.4f}–{label.right:.4f}",
                "implied_pct": round(mid * 100.0, 2),
                "realized_pct": round(win_rate, 1),
                "n": n,
                "ci_low": round(win_rate - ci_half, 1),
                "ci_high": round(win_rate + ci_half, 1),
            }
        )
    return rows


def correlations(df: pd.DataFrame) -> list:
    """Point-biserial / pearson correlation of each feature with win & profit."""
    if df.empty:
        return []
    feats = ["ev_percent", "minutes_to_start", "danske_odds", "abs_handicap", "clv_pct"]
    out = []
    for f in feats:
        sub = df[[f, "won", "profit"]].dropna()
        if len(sub) < 30:
            continue
        out.append(
            {
                "feature": f,
                "corr_with_win": round(float(np.corrcoef(sub[f], sub["won"])[0, 1]), 3),
                "corr_with_profit": round(float(np.corrcoef(sub[f], sub["profit"])[0, 1]), 3),
                "n": len(sub),
            }
        )
    return out


def build_evidence(
    dedup: str = "match_selection",
    min_ev: float = 0.0,
    min_minutes: float = 0.0,
    max_minutes: float = 1e9,
    min_odds: float = 1.0,
    max_odds: float = 1e9,
) -> dict:
    df = load_settled()
    used, meta = apply_view(df, dedup, min_ev, min_minutes, max_minutes, min_odds, max_odds)

    months = _months_span(used)
    overall = None
    if not used.empty:
        s = _roi_stats(used)
        overall = {
            "n": s["n"],
            "wins": s["wins"],
            "win_rate": s["win_rate"],
            "roi": s["roi"],
            "ci_low": s["ci_low"],
            "ci_high": s["ci_high"],
            "avg_clv": s["avg_clv"],
            "bets_per_month": round(s["n"] / months, 1),
            "months": round(months, 1),
        }

    result = {
        "meta": meta,
        "overall": overall,
        "calibration": calibration(used),
        "correlations": correlations(used),
        "dimensions": {},
    }
    for key, _title, col, edges, labels in DIMENSIONS:
        result["dimensions"][key] = {"title": _title, "rows": table_by(used, col, edges, labels)}

    return result


if __name__ == "__main__":
    import json

    res = build_evidence()
    print(json.dumps(res, indent=2, default=str))