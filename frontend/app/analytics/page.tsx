"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';

interface AnalyticsData {
  stats: {
    total_bets: number;
    total_profit: number;
    roi: number;
    win_rate: number;
    avg_clv: number;
  } | null;
  chart_data: {
    id: number;
    date: string;
    match: string;
    profit: number;
  }[];
}

export default function Analytics() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const res = await fetch("/api/analytics");
        const json = await res.json();
        setData(json);
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  if (loading) return <div className="p-8">Loading stats...</div>;

  // Helper for formatting currency
  const formatDKK = (val: number) => `${val.toLocaleString('da-DK')} kr.`;

  // Custom Tooltip for the Chart
  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      const point = payload[0].payload;
      return (
        <div className="rounded-lg border border-slate-700 bg-slate-900 p-3 text-sm shadow-xl shadow-black/40">
          <p className="mb-1 font-bold text-slate-100">{point.date}</p>
          <p className="mb-2 text-xs text-slate-400">{point.match}</p>
          <p
            className={`font-mono font-bold ${
              point.profit >= 0 ? "text-emerald-400" : "text-rose-400"
            }`}
          >
            Total PnL: {formatDKK(point.profit)}
          </p>
        </div>
      );
    }
    return null;
  };

  return (
    <main className="min-h-screen bg-slate-950 font-sans text-slate-100">
      <div className="mx-auto max-w-6xl px-4 py-6 md:px-6 lg:py-8">
        {/* HEADER */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight text-slate-50 sm:text-3xl">
            Performance Analytics
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <Link
              href="/"
              className="font-medium text-emerald-400 hover:text-emerald-300 hover:underline"
            >
              ← Back to Scanner
            </Link>
            <span className="text-slate-600">•</span>
            <Link href="/portfolio" className="font-medium text-emerald-400 hover:text-emerald-300 hover:underline">
              View Portfolio
            </Link>
          </div>
        </div>

        {!data?.stats ? (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-6 text-amber-300">
            No settled bets found. Go settle some bets in your Portfolio to see stats!
          </div>
        ) : (
          <>
            {/* STAT CARDS */}
            <div className="mb-8 grid grid-cols-2 gap-3 md:grid-cols-5">
              <StatCard label="Total Bets" value={data.stats.total_bets} />

              <StatCard
                label="Total Profit"
                value={formatDKK(data.stats.total_profit)}
                color={data.stats.total_profit >= 0 ? "text-emerald-400" : "text-rose-400"}
              />

              <StatCard
                label="ROI"
                value={`${data.stats.roi}%`}
                color={data.stats.roi >= 0 ? "text-emerald-400" : "text-rose-400"}
              />

              <StatCard label="Win Rate" value={`${data.stats.win_rate}%`} />

              <StatCard
                label="Avg CLV"
                value={`${data.stats.avg_clv > 0 ? "+" : ""}${data.stats.avg_clv}%`}
                color={data.stats.avg_clv > 0 ? "text-emerald-400" : "text-amber-400"}
                subtext="Beat Closing Line?"
              />
            </div>

            {/* CHART SECTION */}
            <div className="card h-[420px] p-5 sm:p-6">
              <h3 className="mb-6 text-lg font-bold text-slate-100">
                Cumulative Profit/Loss
              </h3>

              <ResponsiveContainer width="100%" height="85%">
                <LineChart data={data.chart_data}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#1e293b" />
                  <XAxis dataKey="date" hide />
                  <YAxis tick={{ fill: "#64748b", fontSize: 12 }} />
                  <Tooltip content={<CustomTooltip />} />
                  <ReferenceLine y={0} stroke="#475569" strokeDasharray="3 3" />
                  <Line
                    type="monotone"
                    dataKey="profit"
                    stroke="#10b981"
                    strokeWidth={2}
                    dot={{ r: 3, fill: "#10b981" }}
                    activeDot={{ r: 6 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </>
        )}
      </div>
    </main>
  );
}

// Simple Sub-component for Cards
function StatCard({ label, value, color = "text-slate-100", subtext }: any) {
  return (
    <div className="card px-4 py-4">
      <p className="label-sm">{label}</p>
      <p className={`mt-1 text-xl font-bold sm:text-2xl ${color}`}>{value}</p>
      {subtext && <p className="mt-1 text-[10px] text-slate-500">{subtext}</p>}
    </div>
  );
}