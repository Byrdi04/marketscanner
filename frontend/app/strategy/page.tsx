"use client";

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import Link from "next/link";
import {
  ResponsiveContainer, BarChart, Bar, Cell, ErrorBar, XAxis, YAxis,
  Tooltip, ReferenceLine, CartesianGrid, LineChart, Line, Legend,
} from "recharts";
import {
  StrategyRule, DEFAULT_RULE_VALUES, ruleDisplayName, ruleSummary, clamp,
  RULE_EV_MIN, RULE_EV_MAX, RULE_HOUR_MIN, RULE_HOUR_MAX,
  fetchRules, saveRules,
} from "../rules";

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
  const [rules, setRules] = useState<StrategyRule[]>([]);
  const [activeRuleNumber, setActiveRuleNumber] = useState<number | null>(null);
  const [ruleSaveState, setRuleSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const rulesDirtyRef = useRef<string | null>(null);
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

  /* ------------------------------ saved rules ------------------------------ */
  useEffect(() => {
    (async () => {
      const r = await fetchRules();
      setRules(r);
      rulesDirtyRef.current = JSON.stringify(r);
    })();
  }, []);

  const rulesDirty = useMemo(() => JSON.stringify(rules) !== rulesDirtyRef.current, [rules]);

  const applyRule = (rule: StrategyRule) => {
    setMinEv(clamp(rule.min_ev, RULE_EV_MIN, RULE_EV_MAX));
    setMaxEv(clamp(rule.max_ev, RULE_EV_MIN, RULE_EV_MAX));
    setMinHours(clamp(rule.min_minutes == null ? RULE_HOUR_MIN : Math.round(rule.min_minutes / 60), RULE_HOUR_MIN, RULE_HOUR_MAX));
    setMaxHours(clamp(rule.max_minutes == null ? RULE_HOUR_MAX : Math.round(rule.max_minutes / 60), RULE_HOUR_MIN, RULE_HOUR_MAX));
    setMinOdds(rule.min_odds);
    setMaxOdds(rule.max_odds);
    setActiveRuleNumber(rule.rule_number);
  };

  const changeMinEv = (raw: number) => {
    const v = Math.min(clamp(raw, RULE_EV_MIN, RULE_EV_MAX), maxEv);
    setMinEv(v);
    if (activeRuleNumber != null) setRules((prev) => prev.map((r) => r.rule_number === activeRuleNumber ? { ...r, min_ev: v } : r));
  };
  const changeMaxEv = (raw: number) => {
    const v = Math.max(clamp(raw, RULE_EV_MIN, RULE_EV_MAX), minEv);
    setMaxEv(v);
    if (activeRuleNumber != null) setRules((prev) => prev.map((r) => r.rule_number === activeRuleNumber ? { ...r, max_ev: v } : r));
  };
  const changeMinHours = (raw: number) => {
    const v = Math.min(clamp(raw, RULE_HOUR_MIN, RULE_HOUR_MAX), maxHours);
    setMinHours(v);
    if (activeRuleNumber != null) setRules((prev) => prev.map((r) => r.rule_number === activeRuleNumber ? { ...r, min_minutes: v * 60 } : r));
  };
  const changeMaxHours = (raw: number) => {
    const v = Math.max(clamp(raw, RULE_HOUR_MIN, RULE_HOUR_MAX), minHours);
    setMaxHours(v);
    if (activeRuleNumber != null) setRules((prev) => prev.map((r) => r.rule_number === activeRuleNumber ? { ...r, max_minutes: v * 60 } : r));
  };
  const changeMinOdds = (raw: number) => {
    const v = raw;
    setMinOdds(v);
    if (activeRuleNumber != null) setRules((prev) => prev.map((r) => r.rule_number === activeRuleNumber ? { ...r, min_odds: v } : r));
  };
const changeMaxOdds = (raw: number) => {
    const v = raw;
    setMaxOdds(v);
    if (activeRuleNumber != null) setRules((prev) => prev.map((r) => r.rule_number === activeRuleNumber ? { ...r, max_odds: v } : r));
  };

  const handleSaveAsNewRule = () => {
    const name = window.prompt("Name this rule (optional):");
    if (name == null) return;
    const nextNumber = rules.reduce((mx, r) => Math.max(mx, r.rule_number), 0) + 1;
    const newRule: StrategyRule = {
      ...DEFAULT_RULE_VALUES,
      rule_number: nextNumber,
      name: name.trim() ? name.trim() : null,
      min_ev: minEv,
      max_ev: maxEv,
      min_odds: minOdds,
      max_odds: maxOdds,
      min_minutes: minHours * 60,
      max_minutes: maxHours * 60,
    };
    setRules((prev) => [...prev, newRule]);
    applyRule(newRule);
  };

  const handleSaveRules = async () => {
    setRuleSaveState("saving");
    const ok = await saveRules(rules);
    if (ok) {
      rulesDirtyRef.current = JSON.stringify(rules);
      setRuleSaveState("saved");
    } else {
      setRuleSaveState("error");
    }
    setTimeout(() => setRuleSaveState("idle"), 2500);
  };

  const handleDeleteRule = () => {
    if (activeRuleNumber == null) return;
    setRules((prev) => prev.filter((r) => r.rule_number !== activeRuleNumber));
    setActiveRuleNumber(null);
  };

  /* ------------------------------ derived ------------------------------ */
  return (
    <main className="min-h-screen bg-slate-950 font-sans text-slate-100">
      <div className="mx-auto max-w-7xl px-4 py-6 md:px-6 lg:py-8">
        {/* HEADER */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight text-slate-50 sm:text-3xl">
            Strategy Analysis
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <Link
              href="/"
              className="font-medium text-emerald-400 hover:text-emerald-300 hover:underline"
            >
              ← Scanner
            </Link>
            <span className="text-slate-600">•</span>
            <Link
              href="/paper-trading"
              className="font-medium text-emerald-400 hover:text-emerald-300 hover:underline"
            >
              Paper Trading
            </Link>
            <span className="text-slate-600">•</span>
            <Link
              href="/analytics"
              className="font-medium text-emerald-400 hover:text-emerald-300 hover:underline"
            >
              Analytics
            </Link>
            <span className="w-full text-xs text-slate-500 sm:ml-auto sm:w-auto">
              Already-collected paper bets only · no extra API credits
            </span>
          </div>

          {/* TABS */}
          <div className="mt-4 flex flex-wrap gap-2">
            {([
              ["evidence", "Evidence tables"],
              ["model", "Model & Frontier"],
            ] as [Tab, string][]).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`rounded-md border px-4 py-2 text-sm font-medium transition-colors ${
                  tab === key
                    ? "border-emerald-500 bg-emerald-500 text-slate-950"
                    : "border-slate-700 bg-slate-800/60 text-slate-300 hover:border-emerald-500/60"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* CONTROLS */}
        <section className="card mb-6 p-5">
          {/* RULE SELECTOR */}
          <div className="mb-4 flex flex-wrap items-end gap-3 rounded-md border border-slate-700 bg-slate-800/40 p-3">
            <label className="block min-w-64 flex-1">
              <span className="text-xs uppercase font-semibold text-slate-500">
                Saved rule — loads its filters to see the outcome
              </span>
              <select
                value={activeRuleNumber == null ? "" : String(activeRuleNumber)}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "") {
                    setActiveRuleNumber(null);
                  } else {
                    const rule = rules.find((r) => String(r.rule_number) === v);
                    if (rule) applyRule(rule);
                  }
                }}
                className="select mt-1"
              >
                <option value="">🎯 Free selection — no rule applied; sliders won't edit any saved rule</option>
                {rules.map((r) => (
                  <option key={r.rule_number} value={String(r.rule_number)}>
                    {ruleDisplayName(r)} — {ruleSummary(r)}
                  </option>
                ))}
              </select>
            </label>

            <button
              onClick={handleSaveAsNewRule}
              className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-sm font-medium text-emerald-300 transition-colors hover:bg-emerald-500/20"
            >
              ＋ Save current as new rule
            </button>

            <button
              onClick={handleSaveRules}
              disabled={ruleSaveState === "saving" || !rulesDirty}
              className="px-3 py-1.5 rounded-md text-sm font-medium border border-sky-500/40 text-sky-300 bg-sky-500/10 hover:bg-sky-500/20 disabled:opacity-50 transition-colors"
            >
              {ruleSaveState === "saving" && "Saving…"}
              {ruleSaveState === "saved" && "Rules saved ✓"}
              {ruleSaveState === "error" && "Save failed — retry"}
              {ruleSaveState === "idle" && (rulesDirty ? "Save rules" : "All rules saved")}
            </button>

            {activeRuleNumber != null && (
              <button
                onClick={handleDeleteRule}
                className="px-3 py-1.5 rounded-md text-sm font-medium border border-rose-500/30 text-rose-300 bg-transparent hover:bg-rose-500/10 transition-colors"
              >
                Delete rule
              </button>
            )}

            <p className="w-full text-xs text-slate-500">
              {activeRuleNumber == null
                ? "Free selection: adjust the filters freely — saved rules are untouched until you edit them with a rule selected."
                : `Editing "${ruleDisplayName(rules.find((r) => r.rule_number === activeRuleNumber) ?? { rule_number: activeRuleNumber, name: null })}" — slider changes update that rule; press “Save rules” to persist."`}
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 items-end">
            <label className="block">
              <span className="text-xs uppercase font-semibold text-slate-500">Dedup (correlated bets)</span>
              <select
                value={dedup}
                onChange={(e) => setDedup(e.target.value)}
                className="select mt-1"
              >
                {DEDUP_MODES.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="text-xs uppercase font-semibold text-slate-500">
                Min EV: <b>{minEv}%</b>
              </span>
              <input
                type="range" min={RULE_EV_MIN} max={RULE_EV_MAX} step={0.5} value={minEv}
                onChange={(e) => changeMinEv(Number(e.target.value))}
                className="w-full mt-2 accent-emerald-500"
              />
            </label>

            <label className="block">
              <span className="text-xs uppercase font-semibold text-slate-500">
                Max EV: <b>{maxEv}%</b>
              </span>
              <input
                type="range" min={RULE_EV_MIN} max={RULE_EV_MAX} step={0.5} value={maxEv}
                onChange={(e) => changeMaxEv(Number(e.target.value))}
                className="w-full mt-2 accent-emerald-500"
              />
            </label>

            <label className="block">
              <span className="text-xs uppercase font-semibold text-slate-500">
                Bet placed ≥ <b>{minHours}h</b> before start
              </span>
              <input
                type="range" min={RULE_HOUR_MIN} max={RULE_HOUR_MAX} step={1} value={minHours}
                onChange={(e) => changeMinHours(Number(e.target.value))}
                className="w-full mt-2 accent-emerald-500"
              />
            </label>

            <label className="block">
              <span className="text-xs uppercase font-semibold text-slate-500">
                Bet placed ≤ <b>{maxHours}h</b> before start
              </span>
              <input
                type="range" min={RULE_HOUR_MIN} max={RULE_HOUR_MAX} step={1} value={maxHours}
                onChange={(e) => changeMaxHours(Number(e.target.value))}
                className="w-full mt-2 accent-emerald-500"
              />
            </label>

            <label className="block">
              <span className="text-xs uppercase font-semibold text-slate-500">Odds range</span>
              <div className="flex items-center gap-2 mt-1">
                <input
                  type="number" min={1.9} max={2.4} step={0.01} value={minOdds}
                  onChange={(e) => changeMinOdds(Number(e.target.value))}
                  className="input !w-20 !px-2 !py-1.5"
                />
                <span className="text-slate-500">–</span>
                <input
                  type="number" min={1.9} max={2.4} step={0.01} value={maxOdds}
                  onChange={(e) => changeMaxOdds(Number(e.target.value))}
                  className="input !w-20 !px-2 !py-1.5"
                />
              </div>
            </label>
          </div>
          {loading && <p className="text-xs text-slate-500 mt-3">Recalculating…</p>}
          {error && (
            <p className="text-xs text-rose-400 mt-3">Error: {error} — is the backend running?</p>
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
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-6 text-amber-300">
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
          valueClass={data.overall.roi >= 0 ? "text-emerald-400" : "text-rose-400"}
          sub={`95% CI [${data.overall.ci_low}%, ${data.overall.ci_high}%]`}
        />
        <Card
          label="Avg CLV"
          value={data.overall.avg_clv == null ? "–" : `${data.overall.avg_clv >= 0 ? "+" : ""}${data.overall.avg_clv}%`}
          valueClass={(data.overall.avg_clv ?? 0) >= 0 ? "text-emerald-400" : "text-amber-400"}
        />
      </div>

      {/* POOL QUALITY */}
      <div className="card mb-6 p-4 text-xs text-slate-400">
        <span className="font-semibold text-slate-300 uppercase tracking-wide text-[10px]">Pool composition under current filters — </span>
        {data.meta.total_logged.toLocaleString()} logged · {data.meta.n_pending_excluded} pending excluded ·{" "}
        {data.meta.n_settled.toLocaleString()} settled · {data.meta.n_duplicates_excluded.toLocaleString()} duplicates excluded ·{" "}
        {data.meta.n_filtered_out.toLocaleString()} filtered out by thresholds ·{" "}
        <b>{data.meta.n_used.toLocaleString()} used</b>. Note: only EV &gt; 0 bets are ever logged (selection bias), and
        every settled bet here is a Spread.
      </div>

      {/* CALIBRATION */}
      <Section title="Calibration: Pinnacle fair price vs realized win rate" id="calibration">
        <p className="text-sm text-slate-500 mb-3">
          If the EV math were perfectly honest, realized win rate would sit on the dashed 45° line. Points below it mean
          those bets were over-priced (the fair probability was too generous).
        </p>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data.calibration}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#1e293b" />
              <XAxis dataKey="implied_pct" type="number" domain={[40, 55]} tickFormatter={(v) => `${v}%`} tick={{ fill: "#94a3b8" }} />
              <YAxis domain={[35, 65]} tickFormatter={(v) => `${v}%`} tick={{ fill: "#94a3b8" }} />
              <Tooltip formatter={(v: number) => `${v}%`} labelFormatter={(v) => `Implied ${v}%`} contentStyle={{ backgroundColor: "#0f172a", border: "1px solid #334155", borderRadius: 8, color: "#e2e8f0" }} />
              <ReferenceLine segment={[{ x: 40, y: 40 }, { x: 55, y: 55 }]} stroke="#475569" strokeDasharray="4 4" />
              <Line type="monotone" dataKey="realized_pct" stroke="#38bdf8" strokeWidth={2} dot={{ r: 4 }} />
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
            <p className="text-sm text-slate-500 mb-3">{DIMENSION_BLURB[key] ?? ""}</p>
            {dim.rows.length === 0 ? (
              <p className="text-sm text-slate-500">No bets in this view.</p>
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
                          <span className={roi >= 0 ? "text-emerald-400 font-semibold" : "text-rose-400 font-semibold"}>
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
          <p className="text-sm text-slate-500 mb-3">
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
      <div className="rounded-lg border border-sky-500/30 bg-sky-500/10 p-4 text-xs leading-relaxed text-sky-100">
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
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-6 text-amber-300">
      Model data not available. Is the backend running?
    </div>
  );

  if (model.available === false) {
    return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-6 text-amber-300">
        Modelling requires <code>scikit-learn</code> on the backend. Add it to{" "}
        <code>backend/requirements.txt</code> and restart.
      </div>
    );
  }

  if (model.error) {
    return (
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-6 text-amber-300">{model.error}</div>
    );
  }

  const h = model.holdout;
  const m = model.model;
  const decileData = (model.deciles ?? []).map((d) => ({ ...d }));

  return (
    <>
      {/* TEMPORAL SPLIT */}
      <div className="card mb-6 p-4 text-xs text-slate-400">
        <span className="font-semibold text-slate-300 uppercase tracking-wide text-[10px]">Temporal validation — </span>
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
            valueClass={h.roi >= 0 ? "text-emerald-400" : "text-rose-400"}
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
        <p className="text-xs text-slate-500 mt-3 leading-relaxed">
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
          <p className="text-xs text-slate-500 mt-3">
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
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#1e293b" />
                <XAxis dataKey="decile" tick={{ fill: "#94a3b8", fontSize: 12 }} label={{ value: "Decile (1 = lowest predicted win prob)", position: "insideBottom", offset: -2, fontSize: 11, fill: "#94a3b8" }} />
                <YAxis tickFormatter={(v) => `${v}%`} tick={{ fill: "#94a3b8" }} />
                <Tooltip formatter={(v: number, name: string) => (name === "ci_error" ? null : [`${v}%`, "Win rate"])} labelFormatter={(l) => `Decile ${l}`} contentStyle={{ backgroundColor: "#0f172a", border: "1px solid #334155", borderRadius: 8, color: "#e2e8f0" }} />
                <ReferenceLine y={50} stroke="#475569" strokeDasharray="3 3" />
                <Bar dataKey="win_rate" fill="#38bdf8" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="text-xs text-slate-500 mb-3">
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
                    <span className={roi >= 0 ? "text-emerald-400 font-semibold" : "text-rose-400 font-semibold"}>
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
        <p className="text-sm text-slate-500 mb-3">
          Every candidate rule {`"EV ≥ x · taken ≥ y hours before start"`} plotted on the temporal holdout. This is the
          bets-vs-most-efficient-strategy trade-off: more bets per month = tighter CIs but you bet the whole +EV
          universe; fewer = higher ROI point estimates but razor-thin samples. Pick the least restrictive rule whose
          ROI remains plausibly &gt; 0.
        </p>
        {frontierSeries.length > 0 ? (
          <div className="h-80 mb-4">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart margin={{ top: 10, right: 20, bottom: 5, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#1e293b" />
                <XAxis
                  type="number" dataKey="bets_per_month" scale="log" domain={[5, 700]} allowDataOverflow
                  label={{ value: "Bets per month (log scale)", position: "insideBottom", offset: -2, fontSize: 11, fill: "#94a3b8" }}
                  tick={{ fill: "#94a3b8", fontSize: 12 }}
                />
                <YAxis tickFormatter={(v) => `${v}%`} domain={[-20, 40]} tick={{ fill: "#94a3b8" }} />
                <Tooltip
                  formatter={(v: number, name: string) => (name === "roi" ? [`${v}% ROI`, "ROI"] : null)}
                  labelFormatter={(l) => `~${Math.round(Number(l))} bets/mo`}
                  content={(props: { active?: boolean; payload?: ReadonlyArray<{ payload: FrontierPoint }> }) => {
                    const { active: isActive, payload } = props;
                    if (!isActive || !payload?.length) return null;
                    const p = payload[0].payload;
                    return (
                      <div className="rounded-lg border border-slate-700 bg-slate-900 p-3 text-xs shadow-xl shadow-black/40">
                        <p className="font-bold mb-1">{p.rule}</p>
                        <p>Bets: {p.n} · ~{p.bets_per_month}/mo</p>
                        <p className="font-semibold">
                          ROI: <span className={p.roi >= 0 ? "text-emerald-400" : "text-rose-400"}>{p.roi}%</span>{" "}
                          <span className="text-slate-500">[{p.ci_low}%, {p.ci_high}%]</span>
                        </p>
                      </div>
                    );
                  }}
                />
                <ReferenceLine y={0} stroke="#475569" strokeDasharray="3 3" />
                {frontierSeries.map((s) => (
                  <Line
                    key={s.ev}
                    type="monotone" data={s.pts} dataKey="roi"
                    name={`EV ≥ ${s.ev}%`}
                    stroke={EV_COLORS[EV_GRID.indexOf(s.ev)] ?? "#000"}
                    strokeWidth={2} dot={{ r: 4 }} activeDot={{ r: 6 }}
                  />
                ))}
                <Legend verticalAlign="top" height={30} wrapperStyle={{ fontSize: 12, color: "#94a3b8" }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <p className="text-sm text-slate-500">No sweep rows for these filters.</p>
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
                    <span className={roi >= 0 ? "text-emerald-400 font-semibold" : "text-rose-400 font-semibold"}>
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

        <div className="rounded-lg border border-sky-500/30 bg-sky-500/10 p-4 text-xs leading-relaxed text-sky-100">
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

function Card({ label, value, valueClass = "text-slate-100", sub }: {
  label: string; value: string; valueClass?: string; sub?: string;
}) {
  return (
    <div className="card p-4">
      <p className="text-[10px] text-slate-500 uppercase font-semibold">{label}</p>
      <p className={`text-xl font-bold mt-1 ${valueClass}`}>{value}</p>
      {sub && <p className="text-[10px] text-slate-500 mt-1">{sub}</p>}
    </div>
  );
}

function MetricBox({ label, value, sub, accent = "gray" }: {
  label: string; value: string; sub?: string; accent?: "green" | "gray";
}) {
  return (
    <div className={`rounded-lg border p-4 ${accent === "green" ? "border-emerald-500/30 bg-emerald-500/10" : "border-slate-700 bg-slate-800/50"}`}>
      <p className="text-[10px] text-slate-500 uppercase font-semibold">{label}</p>
      <p className="text-2xl font-bold mt-1 font-mono">{value}</p>
      {sub && <p className="text-[10px] text-slate-500 mt-1">{sub}</p>}
    </div>
  );
}

function Section({ title, id, children }: { title: string; id: string; children: React.ReactNode }) {
  return (
    <section id={id} className="card mb-6 p-5 sm:p-6">
      <h2 className="text-lg font-bold text-slate-300 mb-2">{title}</h2>
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
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#1e293b" />
          <XAxis dataKey="bin" tick={{ fill: "#94a3b8", fontSize: 12 }} />
          <YAxis tickFormatter={(v) => `${v}%`} tick={{ fill: "#94a3b8" }} />
          <Tooltip
            formatter={(v: number, name: string) => (name === "ci_error" ? null : [`${v}% ROI`, "ROI"])}
            labelFormatter={(l) => `Bin: ${l}`}
            contentStyle={{ backgroundColor: "#0f172a", border: "1px solid #334155", borderRadius: 8, color: "#e2e8f0" }}
          />
          <ReferenceLine y={0} stroke="#475569" strokeDasharray="3 3" />
          <Bar dataKey="roi" radius={[3, 3, 0, 0]}>
            {chartData.map((r, i) => (
              <Cell key={i} fill={r.roi >= 0 ? "#10b981" : "#f43f5e"} />
            ))}
            <ErrorBar dataKey="ci_error" width={6} strokeWidth={1.5} stroke="#94a3b8" />
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
          active ? "text-emerald-400" : "text-slate-500"
        }`}
      >
        {col.label} {active ? (asc ? "▲" : "▼") : ""}
      </th>
    );
  };

  return (
    <div className="overflow-x-auto">
      <table className="data-table text-sm">
        <thead className="border-b border-slate-700/80">
          <tr>{columns.map(header)}</tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => (
            <tr key={i} className="border-b border-slate-800 transition-colors hover:bg-slate-800/40">
              {columns.map((col) => (
                <td
                  key={col.key}
                  data-label={col.label}
                  className="whitespace-nowrap px-3 py-2 text-slate-300"
                >
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