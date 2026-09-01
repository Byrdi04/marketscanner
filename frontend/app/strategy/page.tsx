"use client";

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import Link from "next/link";
import {
  ResponsiveContainer, BarChart, Bar, Cell, ErrorBar, XAxis, YAxis,
  Tooltip, ReferenceLine, CartesianGrid, LineChart, Line, Legend,
} from "recharts";

/* ------------------------------------------------------------------ */
/* Types matching backend responses                                    */
/* ------------------------------------------------------------------ */

interface RoiRow extends SortRow {
  bin: string;
  n: number;
  wins: number;
  win_rate: number;
  roi: number;
  ci_low: number;
  ci_high: number;
  avg_clv: number | null;
  bets_per_month: number;
}

interface CalRow {
  band: string;
  implied_pct: number;
  realized_pct: number;
  n: number;
  ci_low: number;
  ci_high: number;
}

interface CorrRow {
  feature: string;
  corr_with_win: number;
  corr_with_profit: number;
  n: number;
}

interface StrategyData {
  meta: {
    dedup: string;
    total_logged: number;
    n_pending_excluded: number;
    n_settled: number;
    n_duplicates_excluded: number;
    n_filtered_out: number;
    n_used: number;
  };
  overall: {
    n: number; wins: number; win_rate: number; roi: number;
    ci_low: number; ci_high: number; avg_clv: number | null;
    bets_per_month: number; months: number;
  } | null;
  calibration: CalRow[];
  correlations: CorrRow[];
  dimensions: Record<string, { title: string; rows: RoiRow[] }>;
}

interface ModelData {
  available: boolean;
  error?: string;
  meta?: {
    n_used: number;
    split_fraction: number;
    cutoff: string;
    train_n: number;
    holdout_n: number;
  };
  holdout?: {
    n: number; wins: number; win_rate: number; roi: number;
    bets_per_month: number; months: number;
  };
  model?: {
    train_win_rate: number;
    baseline_log_loss: number;
    logistic_log_loss: number;
    gbm_log_loss: number | null;
  };
  coefficients?: { feature: string; label: string; win_coef: number; clv_coef: number | null }[];
  clv_model?: { r2: number | null; n_train: number; n_holdout: number };
  deciles?: { decile: number; band: string; n: number; win_rate: number; roi: number }[];
}

interface SweepRow extends SortRow {
  rule: string;
  min_ev: number;
  min_hours: number;
  n: number;
  wins: number;
  roi: number;
  ci_low: number;
  ci_high: number;
  bets_per_month: number;
}

interface SweepData {
  available: boolean;
  meta?: { dedup: string; cutoff: string; train_n: number; holdout_n: number; months: number };
  rows: SweepRow[];
}

interface FrontierPoint {
  bets_per_month: number;
  roi: number;
  rule: string;
  n: number;
  ci_low: number;
  ci_high: number;
}

const DEDUP_MODES = [
  { value: "none", label: "All logged bets" },
  { value: "match_selection", label: "One per match + selection (earliest price)" },
  { value: "game", label: "One per game (earliest price)" },
] as const;

const DIMENSION_ORDER = [
  "roi_by_ev", "roi_by_time", "roi_by_odds", "roi_by_handicap", "roi_by_clv",
] as const;

const DIMENSION_BLURB: Record<string, string> = {
  roi_by_ev: "Does the EV estimate actually translate to profit? Wide CIs = very noisy evidence.",
  roi_by_time: "Your priored feature: is betting earlier (or later) than game start better?",
  roi_by_odds: "Odds magnitude (decimal odds level). All settled bets are Spreads at 1.93–2.35, so bins are single price levels.",
  roi_by_handicap: "Spread size — favourite vs dog margin.",
  roi_by_clv: "Bets grouped by how much the closing line moved. CLV ≈ true long-run edge, but only 83% of bets have a closing price.",
};

const EV_GRID = [0, 0.5, 1, 2, 3, 5];
const EV_COLORS = ["#94a3b8", "#60a5fa", "#22c55e", "#eab308", "#f97316", "#ef4444"];

type Tab = "evidence" | "model";

export default function StrategyPage() {
  /* ------------------------------- state ------------------------------- */
  const [tab, setTab] = useState<Tab>("evidence");
  const [data, setData] = useState<StrategyData | null>(null);
  const [modelData, setModelData] = useState<ModelData | null>(null);
  const [sweepData, setSweepData] = useState<SweepData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dedup, setDedup] = useState<string>("match_selection");
  const [minEv, setMinEv] = useState(0);
  const [maxEv, setMaxEv] = useState(10);
  const [minHours, setMinHours] = useState(0);
  const [maxHours, setMaxHours] = useState(23);
  const [minOdds, setMinOdds] = useState(1.9);
  const [maxOdds, setMaxOdds] = useState(2.4);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* ------------------------------ fetching ----------------------------- */
  const buildUrls = useCallback(() => {
    const base = {
      dedup,
      min_ev: String(minEv),
      max_ev: String(maxEv),
      min_minutes: String(minHours * 60),
      max_minutes: String(maxHours * 60),
      min_odds: String(minOdds),
      max_odds: String(maxOdds),
    };
    const q = new URLSearchParams(base);
    return {
      evidence: `/api/strategy-analysis?${q.toString()}`,
      model: `/api/strategy-model?${q.toString()}`,
      sweep: `/api/strategy-sweep?${new URLSearchParams({ dedup, max_ev: String(maxEv), max_hours: String(maxHours), min_odds: String(minOdds), max_odds: String(maxOdds) }).toString()}`,
    };
  }, [dedup, minEv, maxEv, minHours, maxHours, minOdds, maxOdds]);

  const fetchData = useCallback(async () => {
    try {
      const urls = buildUrls();
      const [evRes, modelRes, sweepRes] = await Promise.all([
        fetch(urls.evidence),
        fetch(urls.model),
        fetch(urls.sweep),
      ]);
      if (!evRes.ok || !modelRes.ok || !sweepRes.ok) throw new Error("Backend returned an error");
      setData(await evRes.json());
      setModelData(await modelRes.json());
      setSweepData(await sweepRes.json());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load analysis");
    } finally {
      setLoading(false);
    }
  }, [buildUrls]);

  useEffect(() => {
    setLoading(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(fetchData, 350);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [fetchData]);

  /* ------------------------------ derived ------------------------------ */
  return (
    <main className="min-h-screen bg-gray-50 p-8 font-sans text-gray-900">
      <div className="max-w-6xl mx-auto">
        {/* HEADER */}
        <div className="mb-6">
          <h1 className="text-3xl font-bold tracking-tight">Strategy Analysis</h1>
          <div className="flex gap-4 mt-2 text-sm">
            <Link href="/" className="text-blue-600 hover:underline">← Scanner</Link>
            <span className="text-gray-300">|</span>
            <Link href="/paper-trading" className="text-purple-600 hover:underline">Paper Trading 🤖</Link>
            <Link href="/analytics" className="text-blue-600 hover:underline">Analytics 📊</Link>
            <span className="text-gray-400 ml-auto text-xs self-center">
              Already-collected paper bets only · no extra API credits
            </span>
          </div>

          {/* TABS */}
          <div className="flex gap-2 mt-4">
            {([
              ["evidence", "Evidence tables"],
              ["model", "Model & Frontier"],
            ] as [Tab, string][]).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`px-4 py-2 rounded-md text-sm font-medium border transition-colors ${
                  tab === key
                    ? "bg-emerald-600 text-white border-emerald-600"
                    : "bg-white text-gray-600 border-gray-300 hover:border-emerald-400"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* CONTROLS */}
        <section className="bg-white p-5 rounded-lg shadow-sm border border-gray-200 mb-6">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 items-end">
            <label className="block">
              <span className="text-xs uppercase font-semibold text-gray-500">Dedup (correlated bets)</span>
              <select
                value={dedup}
                onChange={(e) => setDedup(e.target.value)}
                className="mt-1 w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm bg-white"
              >
                {DEDUP_MODES.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="text-xs uppercase font-semibold text-gray-500">
                Min EV: <b>{minEv}%</b>
              </span>
              <input
                type="range" min={0} max={10} step={0.5} value={minEv}
                onChange={(e) => setMinEv(Math.min(Number(e.target.value), maxEv))}
                className="w-full mt-2 accent-blue-600"
              />
            </label>

            <label className="block">
              <span className="text-xs uppercase font-semibold text-gray-500">
                Max EV: <b>{maxEv}%</b>
              </span>
              <input
                type="range" min={0} max={10} step={0.5} value={maxEv}
                onChange={(e) => setMaxEv(Math.max(Number(e.target.value), minEv))}
                className="w-full mt-2 accent-blue-600"
              />
            </label>

            <label className="block">
              <span className="text-xs uppercase font-semibold text-gray-500">
                Bet placed ≥ <b>{minHours}h</b> before start
              </span>
              <input
                type="range" min={0} max={23} step={1} value={minHours}
                onChange={(e) => setMinHours(Math.min(Number(e.target.value), maxHours))}
                className="w-full mt-2 accent-blue-600"
              />
            </label>

            <label className="block">
              <span className="text-xs uppercase font-semibold text-gray-500">
                Bet placed ≤ <b>{maxHours}h</b> before start
              </span>
              <input
                type="range" min={0} max={23} step={1} value={maxHours}
                onChange={(e) => setMaxHours(Math.max(Number(e.target.value), minHours))}
                className="w-full mt-2 accent-blue-600"
              />
            </label>

            <label className="block">
              <span className="text-xs uppercase font-semibold text-gray-500">Odds range</span>
              <div className="flex items-center gap-2 mt-1">
                <input
                  type="number" min={1.9} max={2.4} step={0.01} value={minOdds}
                  onChange={(e) => setMinOdds(Number(e.target.value))}
                  className="w-20 border border-gray-300 rounded-md px-2 py-1.5 text-sm"
                />
                <span className="text-gray-400">–</span>
                <input
                  type="number" min={1.9} max={2.4} step={0.01} value={maxOdds}
                  onChange={(e) => setMaxOdds(Number(e.target.value))}
                  className="w-20 border border-gray-300 rounded-md px-2 py-1.5 text-sm"
                />
              </div>
            </label>
          </div>
          {loading && <p className="text-xs text-gray-400 mt-3">Recalculating…</p>}
          {error && (
            <p className="text-xs text-red-600 mt-3">Error: {error} — is the backend running?</p>
          )}
        </section>

        {tab === "evidence" ? (
          <EvidenceTab data={data} loading={loading} />
        ) : (
          <ModelTab modelData={modelData} sweepData={sweepData} loading={loading} />
        )}
      </div>
    </main>
  );
}

/* ================================================================== */
/* Evidence tab (Phase 1)                                             */
/* ================================================================== */

function EvidenceTab({ data, loading }: { data: StrategyData | null; loading: boolean }) {
  if (!data?.overall) {
    return loading ? null : (
      <div className="bg-yellow-50 border border-yellow-200 p-6 rounded-lg text-yellow-800">
        No settled paper bets found. Data will appear once bets have been settled.
      </div>
    );
  }
  return (
    <>
      {/* OVERALL CARDS */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-4 mb-6">
        <Card label="Bets used" value={data.overall.n.toLocaleString()} />
        <Card label="Months covered" value={`${data.overall.months}`} />
        <Card label="Bets / month" value={`${data.overall.bets_per_month}`} />
        <Card label="Win rate" value={`${data.overall.win_rate}%`} />
        <Card
          label="ROI (unit stake)"
          value={`${data.overall.roi >= 0 ? "+" : ""}${data.overall.roi}%`}
          valueClass={data.overall.roi >= 0 ? "text-green-600" : "text-red-600"}
          sub={`95% CI [${data.overall.ci_low}%, ${data.overall.ci_high}%]`}
        />
        <Card
          label="Avg CLV"
          value={data.overall.avg_clv == null ? "–" : `${data.overall.avg_clv >= 0 ? "+" : ""}${data.overall.avg_clv}%`}
          valueClass={(data.overall.avg_clv ?? 0) >= 0 ? "text-green-600" : "text-yellow-600"}
        />
      </div>

      {/* POOL QUALITY */}
      <div className="bg-white p-4 rounded-lg shadow-sm border border-gray-200 mb-6 text-xs text-gray-600">
        <span className="font-semibold text-gray-700 uppercase tracking-wide text-[10px]">Pool composition under current filters — </span>
        {data.meta.total_logged.toLocaleString()} logged · {data.meta.n_pending_excluded} pending excluded ·{" "}
        {data.meta.n_settled.toLocaleString()} settled · {data.meta.n_duplicates_excluded.toLocaleString()} duplicates excluded ·{" "}
        {data.meta.n_filtered_out.toLocaleString()} filtered out by thresholds ·{" "}
        <b>{data.meta.n_used.toLocaleString()} used</b>. Note: only EV &gt; 0 bets are ever logged (selection bias), and
        every settled bet here is a Spread.
      </div>

      {/* CALIBRATION */}
      <Section title="Calibration: Pinnacle fair price vs realized win rate" id="calibration">
        <p className="text-sm text-gray-500 mb-3">
          If the EV math were perfectly honest, realized win rate would sit on the dashed 45° line. Points below it mean
          those bets were over-priced (the fair probability was too generous).
        </p>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data.calibration}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eee" />
              <XAxis dataKey="implied_pct" type="number" domain={[40, 55]} tickFormatter={(v) => `${v}%`} />
              <YAxis domain={[35, 65]} tickFormatter={(v) => `${v}%`} />
              <Tooltip formatter={(v: number) => `${v}%`} labelFormatter={(v) => `Implied ${v}%`} />
              <ReferenceLine segment={[{ x: 40, y: 40 }, { x: 55, y: 55 }]} stroke="#999" strokeDasharray="4 4" />
              <Line type="monotone" dataKey="realized_pct" stroke="#2563eb" strokeWidth={2} dot={{ r: 4 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <SortableTable
          rows={data.calibration.map((c) => ({
            bin: c.band, n: c.n, win_rate: c.realized_pct, win_rate_label: `${c.realized_pct}%`,
          }))}
          columns={[
            { key: "bin", label: "Implied prob band" },
            { key: "n", label: "Bets" },
            { key: "win_rate", label: "Realized win %", render: (r) => r.win_rate_label },
          ]}
        />
      </Section>

      {/* DIMENSION EVIDENCE */}
      {DIMENSION_ORDER.map((key) => {
        const dim = data.dimensions[key];
        if (!dim) return null;
        return (
          <Section key={key} title={`ROI by ${dim.title}`} id={key}>
            <p className="text-sm text-gray-500 mb-3">{DIMENSION_BLURB[key] ?? ""}</p>
            {dim.rows.length === 0 ? (
              <p className="text-sm text-gray-400">No bets in this view.</p>
            ) : (
              <>
                <RoiChart rows={dim.rows} />
                <SortableTable
                  rows={dim.rows}
                  columns={[
                    { key: "bin", label: dim.title },
                    { key: "n", label: "Bets" },
                    { key: "wins", label: "Wins" },
                    { key: "win_rate", label: "Win %", render: (r) => `${r.win_rate}%` },
                    {
                      key: "roi",
                      label: "ROI %",
                      render: (r) => {
                        const roi = Number(r.roi);
                        return (
                          <span className={roi >= 0 ? "text-green-600 font-semibold" : "text-red-600 font-semibold"}>
                            {roi > 0 ? "+" : ""}{roi}%
                          </span>
                        );
                      },
                    },
                    {
                      key: "ci_low",
                      label: "95% CI",
                      render: (r) => `[${Number(r.ci_low)}%, ${Number(r.ci_high)}%]`,
                    },
                    { key: "bets_per_month", label: "Bets/mo" },
                    {
                      key: "avg_clv",
                      label: "Avg CLV %",
                      render: (r) => {
                        const clv = r.avg_clv == null ? null : Number(r.avg_clv);
                        return clv == null ? "–" : `${clv >= 0 ? "+" : ""}${clv}%`;
                      },
                    },
                  ]}
                />
              </>
            )}
          </Section>
        );
      })}

      {/* CORRELATIONS */}
      {data.correlations.length > 0 && (
        <Section title="Feature correlations (diagnostic)" id="correlations">
          <p className="text-sm text-gray-500 mb-3">
            Correlation of each feature with winning and with per-bet profit. Near-zero values mean the feature does
            not linearly explain outcomes at this sample size.
          </p>
          <SortableTable
            rows={data.correlations.map((c) => ({
              bin: c.feature, n: c.n, corr_win: c.corr_with_win, corr_profit: c.corr_with_profit,
            }))}
            columns={[
              { key: "bin", label: "Feature" },
              { key: "n", label: "Bets (with data)" },
              { key: "corr_win", label: "Corr with win" },
              { key: "corr_profit", label: "Corr with profit" },
            ]}
          />
        </Section>
      )}

      {/* INTERPRETATION */}
      <div className="bg-blue-50 border border-blue-200 p-4 rounded-lg text-xs text-blue-900 leading-relaxed">
        <b>How to read this.</b> The number of bets per month is what any strategy costs: stricter filters shrink the
        pool (larger CIs), looser filters grow it (statistically more stable, but you bet the whole +EV universe,
        which in this 3.5-month capture was roughly break-even to negative). No single bin here is a strategy yet —
        look for effects that persist across the three dedup modes, then validate them on a later time window.
      </div>
    </>
  );
}

/* ================================================================== */
/* Model & Frontier tab (Phase 2 + 3)                                  */
/* ================================================================== */

function ModelTab({ modelData, sweepData, loading }: {
  modelData: ModelData | null;
  sweepData: SweepData | null;
  loading: boolean;
}) {
  const model = modelData;

  const frontierSeries = useMemo(() => {
    if (!sweepData?.rows?.length) return [];
    return EV_GRID.map((ev) => {
      const pts = sweepData.rows
        .filter((r) => r.min_ev === ev)
        .sort((a, b) => a.bets_per_month - b.bets_per_month)
        .map((r) => ({
          bets_per_month: r.bets_per_month,
          roi: r.roi,
          rule: r.rule,
          n: r.n,
          ci_low: r.ci_low,
          ci_high: r.ci_high,
        }));
      return { ev, pts };
    }).filter((s) => s.pts.length > 0);
  }, [sweepData]);

  if (!model) return loading ? null : (
    <div className="bg-yellow-50 border border-yellow-200 p-6 rounded-lg text-yellow-800">
      Model data not available. Is the backend running?
    </div>
  );

  if (model.available === false) {
    return (
      <div className="bg-yellow-50 border border-yellow-200 p-6 rounded-lg text-yellow-800">
        Modelling requires <code>scikit-learn</code> on the backend. Add it to{" "}
        <code>backend/requirements.txt</code> and restart.
      </div>
    );
  }

  if (model.error) {
    return (
      <div className="bg-yellow-50 border border-yellow-200 p-6 rounded-lg text-yellow-800">{model.error}</div>
    );
  }

  const h = model.holdout;
  const m = model.model;
  const decileData = (model.deciles ?? []).map((d) => ({ ...d }));

  return (
    <>
      {/* TEMPORAL SPLIT */}
      <div className="bg-white p-4 rounded-lg shadow-sm border border-gray-200 mb-6 text-xs text-gray-600">
        <span className="font-semibold text-gray-700 uppercase tracking-wide text-[10px]">Temporal validation — </span>
        trained on bets before <b>{model.meta?.cutoff}</b> ({model.meta?.train_n} bets), tested on bets after{" "}
        <b>{model.meta?.cutoff}</b> ({model.meta?.holdout_n} bets, {h?.months} months). The holdout is the only
        timespan that matters when judging whether a rule works.
      </div>

      {/* HOLDOUT + MODEL CARDS */}
      {h && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
          <Card label="Holdout bets" value={h.n.toLocaleString()} />
          <Card label="Holdout win rate" value={`${h.win_rate}%`} />
          <Card
            label="Holdout ROI (unit stake)"
            value={`${h.roi >= 0 ? "+" : ""}${h.roi}%`}
            valueClass={h.roi >= 0 ? "text-green-600" : "text-red-600"}
          />
          <Card label="Holdout bets/mo" value={`${h.bets_per_month}`} />
          {model.clv_model?.r2 != null && (
            <Card label="CLV model R²" value={`${model.clv_model.r2}`} sub={`holdout n=${model.clv_model.n_holdout}`} />
          )}
        </div>
      )}

      {/* MODEL COMPARISON */}
      <Section title="Does the model beat the simple rule? (holdout log loss)" id="model-vs-baseline">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {m && (
            <>
              <MetricBox
                label="Baseline (bet every +EV spread)"
                value={`${m.baseline_log_loss}`}
                sub={`train win rate ${m.train_win_rate}%`}
              />
              <MetricBox
                label="Logistic regression"
                value={`${m.logistic_log_loss}`}
                sub={`${m.logistic_log_loss < m.baseline_log_loss ? "lower = better" : "no better than baseline"}`}
                accent={m.logistic_log_loss < m.baseline_log_loss ? "green" : "gray"}
              />
              <MetricBox
                label="Gradient boosting (cross-check)"
                value={m.gbm_log_loss == null ? "–" : `${m.gbm_log_loss}`}
                sub={m.gbm_log_loss == null ? "not fitted" : m.gbm_log_loss < m.baseline_log_loss ? "beats baseline" : "does NOT beat baseline"}
                accent={m.gbm_log_loss != null && m.gbm_log_loss < m.baseline_log_loss ? "green" : "gray"}
              />
            </>
          )}
        </div>
        <p className="text-xs text-gray-500 mt-3 leading-relaxed">
          Lower log loss = better calibrated predictions. In this capture the logistic model is only barely better than
          the flat baseline, and the boosted model is worse out-of-sample — the honest expectation at this sample size.
          That means a simple threshold rule remains the right deployment vehicle.
        </p>
      </Section>

      {/* COEFFICIENTS */}
      {model.coefficients && model.coefficients.length > 0 && (
        <Section title="Model coefficients (direction of effects)" id="coefficients">
          <SortableTable
            rows={model.coefficients.map((c) => ({
              bin: c.label, n: 0, win_coef: c.win_coef, clv_coef: c.clv_coef ?? "–",
            }))}
            columns={[
              { key: "bin", label: "Feature" },
              {
                key: "win_coef",
                label: "Win model coef",
                render: (r) => <span className="font-mono">{Number(r.win_coef).toFixed(3)}</span>,
              },
              {
                key: "clv_coef",
                label: "CLV model coef",
                render: (r) => (typeof r.clv_coef === "number" ? <span className="font-mono">{r.clv_coef.toFixed(3)}</span> : <span>–</span>),
              },
            ]}
          />
          <p className="text-xs text-gray-500 mt-3">
            Positive win coef = more likely to win at fixed odds (EV effect is positive but small). The CLV model is
            strongly driven by odds magnitude (prices that close away from the taken price), and by EV.
          </p>
        </Section>
      )}

      {/* DECILES */}
      {model.deciles && model.deciles.length > 0 && (
        <Section title="Model ranking on the holdout (predicted probability deciles)" id="deciles">
          <div className="h-64 mb-4">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={decileData}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eee" />
                <XAxis dataKey="decile" tick={{ fontSize: 12 }} label={{ value: "Decile (1 = lowest predicted win prob)", position: "insideBottom", offset: -2, fontSize: 11 }} />
                <YAxis tickFormatter={(v) => `${v}%`} />
                <Tooltip formatter={(v: number, name: string) => (name === "ci_error" ? null : [`${v}%`, "Win rate"])} labelFormatter={(l) => `Decile ${l}`} />
                <ReferenceLine y={50} stroke="#999" strokeDasharray="3 3" />
                <Bar dataKey="win_rate" fill="#2563eb" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="text-xs text-gray-500 mb-3">
            If the model ranked perfectly, win rate would rise from left to right. Here it is noisy — again the
            signature of weak signal at this sample size.
          </p>
          <SortableTable
            rows={model.deciles.map((d) => ({ bin: `Decile ${d.decile}`, n: d.n, win_rate: d.win_rate, roi: d.roi }))}
            columns={[
              { key: "bin", label: "Rank" },
              { key: "n", label: "Bets" },
              { key: "win_rate", label: "Win %", render: (r) => `${r.win_rate}%` },
              {
                key: "roi",
                label: "ROI %",
                render: (r) => {
                  const roi = Number(r.roi);
                  return (
                    <span className={roi >= 0 ? "text-green-600 font-semibold" : "text-red-600 font-semibold"}>
                      {roi > 0 ? "+" : ""}{roi}%
                    </span>
                  );
                },
              },
            ]}
          />
        </Section>
      )}

      {/* FRONTIER */}
      <Section title="Frontier: bets per month vs holdout ROI" id="frontier">
        <p className="text-sm text-gray-500 mb-3">
          Every candidate rule {`"EV ≥ x · taken ≥ y hours before start"`} plotted on the temporal holdout. This is the
          bets-vs-most-efficient-strategy trade-off: more bets per month = tighter CIs but you bet the whole +EV
          universe; fewer = higher ROI point estimates but razor-thin samples. Pick the least restrictive rule whose
          ROI remains plausibly &gt; 0.
        </p>
        {frontierSeries.length > 0 ? (
          <div className="h-80 mb-4">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart margin={{ top: 10, right: 20, bottom: 5, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eee" />
                <XAxis
                  type="number" dataKey="bets_per_month" scale="log" domain={[5, 700]} allowDataOverflow
                  label={{ value: "Bets per month (log scale)", position: "insideBottom", offset: -2, fontSize: 11 }}
                />
                <YAxis tickFormatter={(v) => `${v}%`} domain={[-20, 40]} />
                <Tooltip
                  formatter={(v: number, name: string) => (name === "roi" ? [`${v}% ROI`, "ROI"] : null)}
                  labelFormatter={(l) => `~${Math.round(Number(l))} bets/mo`}
                  content={(props: { active?: boolean; payload?: ReadonlyArray<{ payload: FrontierPoint }> }) => {
                    const { active: isActive, payload } = props;
                    if (!isActive || !payload?.length) return null;
                    const p = payload[0].payload;
                    return (
                      <div className="bg-white p-3 border border-gray-200 shadow-lg rounded text-xs">
                        <p className="font-bold mb-1">{p.rule}</p>
                        <p>Bets: {p.n} · ~{p.bets_per_month}/mo</p>
                        <p className="font-semibold">
                          ROI: <span className={p.roi >= 0 ? "text-green-600" : "text-red-600"}>{p.roi}%</span>{" "}
                          <span className="text-gray-400">[{p.ci_low}%, {p.ci_high}%]</span>
                        </p>
                      </div>
                    );
                  }}
                />
                <ReferenceLine y={0} stroke="#999" strokeDasharray="3 3" />
                {frontierSeries.map((s) => (
                  <Line
                    key={s.ev}
                    type="monotone" data={s.pts} dataKey="roi"
                    name={`EV ≥ ${s.ev}%`}
                    stroke={EV_COLORS[EV_GRID.indexOf(s.ev)] ?? "#000"}
                    strokeWidth={2} dot={{ r: 4 }} activeDot={{ r: 6 }}
                  />
                ))}
                <Legend verticalAlign="top" height={30} wrapperStyle={{ fontSize: 12 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <p className="text-sm text-gray-400">No sweep rows for these filters.</p>
        )}

        {sweepData?.rows?.length ? (
          <SortableTable
            rows={sweepData.rows}
            columns={[
              { key: "rule", label: "Rule" },
              { key: "n", label: "Bets (holdout)" },
              { key: "wins", label: "Wins" },
              {
                key: "roi",
                label: "ROI %",
                render: (r) => {
                  const roi = Number(r.roi);
                  return (
                    <span className={roi >= 0 ? "text-green-600 font-semibold" : "text-red-600 font-semibold"}>
                      {roi > 0 ? "+" : ""}{roi}%
                    </span>
                  );
                },
              },
              {
                key: "ci_low",
                label: "95% CI",
                render: (r) => `[${Number(r.ci_low)}%, ${Number(r.ci_high)}%]`,
              },
              { key: "bets_per_month", label: "Bets/mo" },
            ]}
          />
        ) : null}

        <div className="bg-blue-50 border border-blue-200 p-4 rounded-lg mt-4 text-xs text-blue-900 leading-relaxed">
          <b>Honest read of this sweep.</b> The high-ROI cells (EV ≥ 3–5%, late windows) have 10–70 holdout bets — a
          single lucky stretch moves them by double digits. No cell&apos;s 95% CI excludes 0. The robust message is the
          shape: rules between ~60 and ~150 bets/month (EV ≥ 2–3%, T ≥ 6–12h) sit consistently positive in this
          holdout. Validate any chosen rule on the next month of fresh data before betting real money.
        </div>
      </Section>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Small building blocks                                               */
/* ------------------------------------------------------------------ */

function Card({ label, value, valueClass = "text-gray-900", sub }: {
  label: string; value: string; valueClass?: string; sub?: string;
}) {
  return (
    <div className="bg-white p-4 rounded-lg shadow-sm border border-gray-200">
      <p className="text-[10px] text-gray-500 uppercase font-semibold">{label}</p>
      <p className={`text-xl font-bold mt-1 ${valueClass}`}>{value}</p>
      {sub && <p className="text-[10px] text-gray-400 mt-1">{sub}</p>}
    </div>
  );
}

function MetricBox({ label, value, sub, accent = "gray" }: {
  label: string; value: string; sub?: string; accent?: "green" | "gray";
}) {
  return (
    <div className={`rounded-lg border p-4 ${accent === "green" ? "border-green-200 bg-green-50" : "border-gray-200 bg-gray-50"}`}>
      <p className="text-[10px] text-gray-500 uppercase font-semibold">{label}</p>
      <p className="text-2xl font-bold mt-1 font-mono">{value}</p>
      {sub && <p className="text-[10px] text-gray-500 mt-1">{sub}</p>}
    </div>
  );
}

function Section({ title, id, children }: { title: string; id: string; children: React.ReactNode }) {
  return (
    <section id={id} className="bg-white p-6 rounded-lg shadow-sm border border-gray-200 mb-6">
      <h2 className="text-lg font-bold text-gray-700 mb-2">{title}</h2>
      {children}
    </section>
  );
}

function RoiChart({ rows }: { rows: RoiRow[] }) {
  const chartData = rows.map((r) => ({ ...r, ci_error: (r.ci_high - r.ci_low) / 2 }));
  return (
    <div className="h-64 mb-4">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData} margin={{ top: 10, right: 20, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eee" />
          <XAxis dataKey="bin" tick={{ fontSize: 12 }} />
          <YAxis tickFormatter={(v) => `${v}%`} />
          <Tooltip
            formatter={(v: number, name: string) => (name === "ci_error" ? null : [`${v}% ROI`, "ROI"])}
            labelFormatter={(l) => `Bin: ${l}`}
          />
          <ReferenceLine y={0} stroke="#999" strokeDasharray="3 3" />
          <Bar dataKey="roi" radius={[3, 3, 0, 0]}>
            {chartData.map((r, i) => (
              <Cell key={i} fill={r.roi >= 0 ? "#16a34a" : "#dc2626"} />
            ))}
            <ErrorBar dataKey="ci_error" width={6} strokeWidth={1.5} stroke="#6b7280" />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

type SortRow = { [key: string]: number | string | null | undefined };
type SortCol = { key: string; label: string; render?: (row: SortRow) => React.ReactNode };

function SortableTable({ rows, columns }: { rows: SortRow[]; columns: SortCol[] }) {
  const [sortKey, setSortKey] = useState("n");
  const [asc, setAsc] = useState(false);

  const sorted = useMemo(() => {
    const arr = [...rows];
    const v = (r: SortRow) => {
      const val = r[sortKey];
      return typeof val === "number" ? val : String(val ?? "");
    };
    arr.sort((a, b) => {
      const av = v(a), bv = v(b);
      const cmp = typeof av === "number" && typeof bv === "number"
        ? av - bv
        : String(av).localeCompare(String(bv));
      return asc ? cmp : -cmp;
    });
    return arr;
  }, [rows, sortKey, asc]);

  const header = (col: SortCol) => {
    const active = sortKey === col.key;
    return (
      <th
        key={col.key}
        onClick={() => {
          if (active) setAsc(!asc);
          else { setSortKey(col.key); setAsc(false); }
        }}
        className={`px-3 py-2 text-[11px] uppercase tracking-wide font-semibold text-left cursor-pointer select-none whitespace-nowrap ${
          active ? "text-blue-600" : "text-gray-500"
        }`}
      >
        {col.label} {active ? (asc ? "▲" : "▼") : ""}
      </th>
    );
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-b border-gray-200">
          <tr>{columns.map(header)}</tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => (
            <tr key={i} className="border-b border-gray-100 hover:bg-gray-50">
              {columns.map((col) => (
                <td key={col.key} className="px-3 py-2 whitespace-nowrap text-gray-700">
                  {col.render ? col.render(r) : String(r[col.key] ?? "–")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}