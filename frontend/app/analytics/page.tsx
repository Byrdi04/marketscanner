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
        <div className="bg-white p-3 border border-gray-200 shadow-lg rounded text-sm">
          <p className="font-bold mb-1">{point.date}</p>
          <p className="text-gray-600 text-xs mb-2">{point.match}</p>
          <p className={`font-mono font-bold ${point.profit >= 0 ? "text-green-600" : "text-red-600"}`}>
            Total PnL: {formatDKK(point.profit)}
          </p>
        </div>
      );
    }
    return null;
  };

  return (
    <main className="min-h-screen bg-gray-50 p-8 font-sans text-gray-900">
      <div className="max-w-6xl mx-auto">
        
        {/* HEADER */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold tracking-tight">Performance Analytics</h1>
          <div className="flex gap-4 mt-2 text-sm">
            <Link href="/" className="text-blue-600 hover:underline">← Back to Scanner</Link>
            <span className="text-gray-400">|</span>
            <Link href="/portfolio" className="text-blue-600 hover:underline">View Portfolio</Link>
          </div>
        </div>

        {!data?.stats ? (
          <div className="bg-yellow-50 border border-yellow-200 p-6 rounded-lg text-yellow-800">
            No settled bets found. Go settle some bets in your Portfolio to see stats!
          </div>
        ) : (
          <>
            {/* STAT CARDS */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
              
              <StatCard label="Total Bets" value={data.stats.total_bets} />
              
              <StatCard 
                label="Total Profit" 
                value={formatDKK(data.stats.total_profit)} 
                color={data.stats.total_profit >= 0 ? "text-green-600" : "text-red-600"} 
              />
              
              <StatCard 
                label="ROI" 
                value={`${data.stats.roi}%`} 
                color={data.stats.roi >= 0 ? "text-green-600" : "text-red-600"} 
              />
              
              <StatCard 
                label="Win Rate" 
                value={`${data.stats.win_rate}%`} 
              />
              
              <StatCard 
                label="Avg CLV" 
                value={`${data.stats.avg_clv > 0 ? "+" : ""}${data.stats.avg_clv}%`} 
                color={data.stats.avg_clv > 0 ? "text-green-600" : "text-yellow-600"}
                subtext="Beat Closing Line?"
              />
            </div>

            {/* CHART SECTION */}
            <div className="bg-white p-6 rounded-lg shadow-sm border border-gray-200 h-[500px]">
              <h3 className="text-lg font-bold mb-6 text-gray-700">Cumulative Profit/Loss</h3>
              
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data.chart_data}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#eee" />
                  <XAxis dataKey="date" hide />
                  <YAxis />
                  <Tooltip content={<CustomTooltip />} />
                  <ReferenceLine y={0} stroke="#999" strokeDasharray="3 3" />
                  <Line 
                    type="monotone" 
                    dataKey="profit" 
                    stroke="#000" 
                    strokeWidth={2} 
                    dot={{ r: 3, fill: '#000' }} 
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
function StatCard({ label, value, color = "text-gray-900", subtext }: any) {
  return (
    <div className="bg-white p-4 rounded-lg shadow-sm border border-gray-200">
      <p className="text-xs text-gray-500 uppercase font-semibold">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${color}`}>{value}</p>
      {subtext && <p className="text-[10px] text-gray-400 mt-1">{subtext}</p>}
    </div>
  );
}