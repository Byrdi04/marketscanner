"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

interface Bet {
  id: number;
  match_name: string;
  selection: string;
  market_type: string;
  handicap: number | null;
  danske_odds: number;
  stake: number;
  status: string;
  result_score: string | null;
  timestamp: string;
  closing_odds: number | null;
}

export default function Portfolio() {
  const [bets, setBets] = useState<Bet[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchBets = async () => {
    const res = await fetch(`/api/my-bets`);
    const json = await res.json();
    setBets(json.data);
  };

  const handleSettle = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/settle-bets`, { method: "POST" });
      const data = await res.json();
      alert(data.message);
      fetchBets(); // Refresh list
    } catch (err) {
      alert("Failed to settle bets");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBets();
  }, []);

  // Calculate Stats
  const totalStaked = bets.reduce((sum, b) => sum + b.stake, 0);
  const totalReturn = bets.reduce((sum, b) => {
    if (b.status === "Won") return sum + (b.stake * b.danske_odds);
    if (b.status === "Void") return sum + b.stake;
    return sum; // Lost = 0 return
  }, 0);
  
  // Only count settled bets for profit
  const settledBets = bets.filter(b => b.status !== 'Pending');
  const profit = settledBets.reduce((sum, b) => {
    if (b.status === "Won") return sum + (b.stake * b.danske_odds) - b.stake;
    if (b.status === "Lost") return sum - b.stake;
    return sum; 
  }, 0);

  return (
    <main className="min-h-screen bg-slate-950 font-sans text-slate-100">
      <div className="mx-auto max-w-7xl px-4 py-6 md:px-6 lg:py-8">
        {/* HEADER */}
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-50 sm:text-3xl">
              My Portfolio
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              <Link
                href="/"
                className="font-medium text-emerald-400 hover:text-emerald-300 hover:underline"
              >
                ← Back to Scanner
              </Link>
              <span className="text-slate-600">•</span>
              <span className="text-slate-400">
                PnL:{" "}
                <span
                  className={`font-bold ${
                    profit >= 0 ? "text-emerald-400" : "text-rose-400"
                  }`}
                >
                  {profit >= 0 ? "+" : ""}${profit.toFixed(2)}
                </span>
              </span>
            </div>
          </div>

          <button onClick={handleSettle} disabled={loading} className="btn btn-primary sm:self-start">
            {loading ? "Checking Scores…" : "Update Results"}
          </button>
        </div>

        {/* SUMMARY STRIP */}
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="card px-4 py-3">
            <p className="label-sm">Bets</p>
            <p className="mt-1 font-mono text-xl font-bold text-slate-100">{bets.length}</p>
          </div>
          <div className="card px-4 py-3">
            <p className="label-sm">Total Staked</p>
            <p className="mt-1 font-mono text-xl font-bold text-slate-100">
              ${totalStaked.toFixed(0)}
            </p>
          </div>
          <div className="card px-4 py-3">
            <p className="label-sm">Gross Return</p>
            <p className="mt-1 font-mono text-xl font-bold text-slate-100">
              ${totalReturn.toFixed(0)}
            </p>
          </div>
          <div className="card px-4 py-3">
            <p className="label-sm">Net PnL</p>
            <p
              className={`mt-1 font-mono text-xl font-bold ${
                profit >= 0 ? "text-emerald-400" : "text-rose-400"
              }`}
            >
              {profit >= 0 ? "+" : ""}${profit.toFixed(2)}
            </p>
          </div>
        </div>

        {/* TABLE */}
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="data-table text-sm">
              <thead className="border-b border-slate-700/80 bg-slate-900/80 font-semibold text-slate-400">
                <tr>
                  <th className="px-5 py-3">Date</th>
                  <th className="px-5 py-3">Match</th>
                  <th className="px-5 py-3">Selection</th>
                  <th className="px-5 py-3 text-right">Odds</th>
                  <th className="px-5 py-3 text-right">CLV</th>
                  <th className="px-5 py-3 text-right">Stake</th>
                  <th className="px-5 py-3">Result</th>
                  <th className="px-5 py-3 text-right">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {bets.map((bet) => (
                  <tr key={bet.id} className="transition-colors hover:bg-slate-800/40">
                    <td data-label="Date" className="px-5 py-4 text-slate-500">
                      {new Date(bet.timestamp).toLocaleDateString()}
                    </td>
                    <td data-label="Match" className="px-5 py-4 font-medium text-slate-100">
                      {bet.match_name}
                    </td>
                    <td data-label="Selection" className="px-5 py-4 font-medium">
                      {bet.selection}
                      {bet.handicap && (
                        <span className="ml-1 text-slate-500">({bet.handicap})</span>
                      )}
                    </td>
                    <td data-label="Odds" className="px-5 py-4 text-right font-mono text-slate-200">
                      {bet.danske_odds.toFixed(2)}
                    </td>
                    <td data-label="CLV" className="px-5 py-4 font-mono text-slate-400">
                      {bet.closing_odds ? bet.closing_odds.toFixed(2) : "-"}
                      {/* Optional: Calculate % Difference */}
                      {bet.closing_odds &&
                        (() => {
                          // Calculate CLV %: (OddsTaken / ClosingOdds) - 1
                          const clvPercent = ((bet.danske_odds / bet.closing_odds) - 1) * 100;
                          const isPositive = clvPercent > 0;
                          return (
                            <span
                              className={`ml-2 text-xs font-bold ${
                                isPositive ? "text-emerald-400" : "text-rose-400"
                              }`}
                            >
                              {isPositive ? "+" : ""}
                              {clvPercent.toFixed(1)}%
                            </span>
                          );
                        })()}
                    </td>
                    <td data-label="Stake" className="px-5 py-4 text-right font-mono text-slate-300">
                      ${bet.stake}
                    </td>
                    <td data-label="Result" className="px-5 py-4 text-xs text-slate-500">
                      {bet.result_score || "-"}
                    </td>
                    <td data-label="Status" className="px-5 py-4 text-right">
                      <span
                        className={`inline-block rounded-full px-2 py-1 text-xs font-bold ${
                          bet.status === "Won"
                            ? "bg-emerald-500/10 text-emerald-300"
                            : bet.status === "Lost"
                              ? "bg-rose-500/10 text-rose-300"
                              : "bg-amber-500/10 text-amber-300"
                        }`}
                      >
                        {bet.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {bets.length === 0 && (
              <div className="px-5 py-10 text-center text-sm text-slate-500">
                No bets placed yet — head to the scanner and hit Refresh Data.
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}