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
    const res = await fetch("http://127.0.0.1:8000/api/my-bets");
    const json = await res.json();
    setBets(json.data);
  };

  const handleSettle = async () => {
    setLoading(true);
    try {
      const res = await fetch("http://127.0.0.1:8000/api/settle-bets", { method: "POST" });
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
    <main className="min-h-screen bg-gray-50 p-8 font-sans text-gray-900">
      <div className="max-w-5xl mx-auto">
        
        {/* HEADER */}
        <div className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-3xl font-bold">My Portfolio</h1>
            <div className="flex gap-4 mt-2 text-sm">
              <Link href="/" className="text-blue-600 hover:underline">← Back to Scanner</Link>
              <span className="text-gray-400">|</span>
              <span className="text-gray-600">PnL: <span className={profit >= 0 ? "text-green-600 font-bold" : "text-red-600 font-bold"}>${profit.toFixed(2)}</span></span>
            </div>
          </div>
          
          <button
            onClick={handleSettle}
            disabled={loading}
            className="bg-gray-900 text-white px-4 py-2 rounded hover:bg-gray-700 disabled:opacity-50"
          >
            {loading ? "Checking Scores..." : "Update Results"}
          </button>
        </div>

        {/* TABLE */}
        <div className="bg-white shadow rounded-lg overflow-hidden">
          <table className="w-full text-sm text-left">
            <thead className="bg-gray-100 text-gray-600 border-b">
              <tr>
                <th className="px-6 py-3">Date</th>
                <th className="px-6 py-3">Match</th>
                <th className="px-6 py-3">Selection</th>
                <th className="px-6 py-3">Odds</th>
                <th className="px-6 py-3">CLV</th>
                <th className="px-6 py-3">Stake</th>
                <th className="px-6 py-3">Result</th>
                <th className="px-6 py-3 text-right">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {bets.map((bet) => (
                <tr key={bet.id} className="hover:bg-gray-50">
                  <td className="px-6 py-4 text-gray-500">
                    {new Date(bet.timestamp).toLocaleDateString()}
                  </td>
                  <td className="px-6 py-4">{bet.match_name}</td>
                  <td className="px-6 py-4 font-medium">
                    {bet.selection}
                    {bet.handicap && <span className="text-gray-400 ml-1">({bet.handicap})</span>}
                  </td>
                  <td className="px-6 py-4">{bet.danske_odds.toFixed(2)}</td>
                                    <td className="px-6 py-4 font-mono text-gray-500">
                    {bet.closing_odds ? bet.closing_odds.toFixed(2) : "-"}
                    
                    {/* Optional: Calculate % Difference */}
                    {bet.closing_odds && (
                      (() => {
                        // Calculate CLV %: (OddsTaken / ClosingOdds) - 1
                        const clvPercent = ((bet.danske_odds / bet.closing_odds) - 1) * 100;
                        const isPositive = clvPercent > 0;
                        return (
                          <span className={`ml-2 text-xs font-bold ${isPositive ? "text-green-600" : "text-red-500"}`}>
                            {isPositive ? "+" : ""}{clvPercent.toFixed(1)}%
                          </span>
                        );
                      })()
                    )}
                  </td>
                  <td className="px-6 py-4">${bet.stake}</td>
                  <td className="px-6 py-4 text-gray-500 text-xs">
                    {bet.result_score || "-"}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <span className={`px-2 py-1 rounded text-xs font-bold ${
                      bet.status === "Won" ? "bg-green-100 text-green-700" :
                      bet.status === "Lost" ? "bg-red-100 text-red-700" :
                      "bg-yellow-100 text-yellow-700"
                    }`}>
                      {bet.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

      </div>
    </main>
  );
}