"use client";

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import Link from "next/link";
import {
  ResponsiveContainer, BarChart, Bar, Cell, ErrorBar, XAxis, YAxis,
  Tooltip, ReferenceLine, CartesianGrid, LineChart, Line,
} from "recharts";

/* ------------------------------------------------------------------ */
/* Types matching backend/strategy_analysis.py response                */
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

export default function StrategyPage() {
  /* ------------------------------- state ------------------------------- */
  const [data, setData] = useState<StrategyData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dedup, setDedup] = useState<string>("match_selection");
  const [minEv, setMinEv] = useState(0);
  const [minHours, setMinHours] = useState(0);
  const [minOdds, setMinOdds] = useState(1.9);
  const [maxOdds, setMaxOdds] = useState(2.4);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* ------------------------------ fetching ----------------------------- */
  const buildUrl = useCallback(() => {
    const p = new URLSearchParams({
      dedup,
      min_ev: String(minEv),
      min_minutes: String(minHours * 60),
      max_minutes: "100000",
      min_odds: String(minOdds),
      max_odds: String(maxOdds),
    });
    return `/api/strategy-analysis?${p.toString()}`;
  }, [dedup, minEv, minHours, minOdds, maxOdds]);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(buildUrl());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load analysis");
    } finally {
      setLoading(false);
    }
  }, [buildUrl]);

  useEffect(() => {
    setLoading(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(fetchData, 350); // debounce while dragging sliders
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [fetchData]);

  /* ------------------------------ derived ------------------------------ */
  const calChart = useMemo(
    () =>
      (data?.calibration ?? []).map((c) => ({
        ...c,
        label: c.band,
        ideal: c.implied_pct,
      })),
    [data]
  );

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
              Evidence tables from already-collected paper bets · no extra API credits
            </span>
          </div>
        </div>

        {/* CONTROLS */}
        <section className="bg-white p-5 rounded-lg shadow-sm border border-gray-200 mb-6">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 items-end">
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
                onChange={(e) => setMinEv(Number(e.target.value))}
                className="w-full mt-2 accent-blue-600"
              />
            </label>

            <label className="block">
              <span className="text-xs uppercase font-semibold text-gray-500">
                Bet placed ≥ <b>{minHours}h</b> before start
              </span>
              <input
                type="range" min={0} max={23} step={1} value={minHours}
                onChange={(e) => setMinHours(Number(e.target.value))}
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

        {data?.overall ? (
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
                  <LineChart data={calChart}>
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
        ) : (
          !loading && (
            <div className="bg-yellow-50 border border-yellow-200 p-6 rounded-lg text-yellow-800">
              No settled paper bets found. Data will appear once bets have been settled.
            </div>
          )
        )}
      </div>
    </main>
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
            formatter={(v: number, name: string) =>
              name === "ci_error" ? null : [`${v}% ROI`, "ROI"]
            }
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

type SortRow = { bin: string; n: number; [key: string]: number | string | null | undefined };
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