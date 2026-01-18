"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

interface PaperBet {
  id: number;
  match_name: string;
  selection: string;
  market_type: string;
  handicap: number | null;
  danske_odds: number;
  pinnacle_odds: number; // The "Fair" price
  closing_odds: number | null;
  ev_percent: number;
  status: string;
  result_score: string | null;
  timestamp: string;
}

export default function PaperTrading() {
  // Initialize with empty array
  const [bets, setBets] = useState<PaperBet[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchBets = async () => {
    try {
      const res = await fetch(`/api/paper-bets`);
      
      // Safety check: Did the server return an error?
      if (!res.ok) {
        console.error("Server error:", res.statusText);
        setBets([]); 
        return;
      }

      const json = await res.json();
      
      // Safety check: Ensure json.data exists and is an array
      if (json && Array.isArray(json.data)) {
        setBets(json.data);
      } else {
        console.warn("Unexpected API response format:", json);
        setBets([]);
      }
      
    } catch (err) {
      console.error("Error fetching paper bets", err);
      setBets([]);
    }
  };

  const handleForceSettle = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/settle-bets`, { method: "POST" });
      const data = await res.json();
      alert(data.message);
      fetchBets(); 
    } catch (err) {
      alert("Failed to settle");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBets();
  }, []);

  // --- STATISTICS CALCULATION (Flat 1 Unit Stake) ---
  // Safety: Ensure bets is an array before filtering
  const safeBets = Array.isArray(bets) ? bets : [];
  const settledBets = safeBets.filter(b => b.status !== 'Pending');
  const totalBets = settledBets.length;
  
  // Calculate Units Won/Lost
  const unitsProfit = settledBets.reduce((sum, b) => {
    if (b.status === "Won") return sum + (b.danske_odds - 1); // Won 2.00 odds = +1 Unit
    if (b.status === "Lost") return sum - 1;                  // Lost = -1 Unit
    return sum; 
  }, 0);

  const winRate = totalBets > 0 
    ? (settledBets.filter(b => b.status === "Won").length / totalBets) * 100 
    : 0;

  // ROI = Profit / Total Risked
  const roi = totalBets > 0 ? (unitsProfit / totalBets) * 100 : 0;

  return (
    <main className="min-h-screen bg-gray-50 p-8 font-sans text-gray-900">
      <div className="max-w-6xl mx-auto">
        
        {/* HEADER */}
        <div className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Paper Trading</h1>
            <p className="text-sm text-gray-500 mt-1">Automated simulation of every edge found</p>
            
            <div className="flex gap-4 mt-4 text-sm font-medium">
               <Link href="/" className="text-gray-500 hover:text-black hover:underline">← Scanner</Link>
               <Link href="/portfolio" className="text-gray-500 hover:text-black hover:underline">Real Portfolio</Link>
            </div>
          </div>
          
          <div className="flex gap-4 items-center">
             {/* STATS CARD */}
             <div className="bg-white px-4 py-2 rounded shadow-sm border border-gray-200 text-right">
                <div className="text-xs text-gray-400 uppercase font-bold">Simulated Profit</div>
                <div className={`text-xl font-mono font-bold ${unitsProfit >= 0 ? "text-green-600" : "text-red-600"}`}>
                   {unitsProfit > 0 ? "+" : ""}{unitsProfit.toFixed(2)} u
                </div>
                <div className="text-xs text-gray-400">
                    ROI: {roi.toFixed(1)}% | WR: {winRate.toFixed(1)}%
                </div>
             </div>

             <button
                onClick={handleForceSettle}
                disabled={loading}
                className="bg-gray-200 text-gray-700 px-4 py-2 rounded hover:bg-gray-300 disabled:opacity-50 text-sm font-bold"
             >
                {loading ? "Syncing..." : "Force Sync Results"}
             </button>
          </div>
        </div>

        {/* TABLE */}
        <div className="bg-white shadow rounded-lg overflow-hidden border border-gray-200">
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="bg-gray-100 text-gray-600 font-semibold border-b">
                <tr>
                  <th className="px-6 py-3">Found At</th>
                  <th className="px-6 py-3">Match</th>
                  <th className="px-6 py-3">Selection</th>
                  <th className="px-6 py-3 text-right">Danske (Soft)</th>
                  <th className="px-6 py-3 text-right">Pinnacle (Fair)</th>
                  <th className="px-6 py-3 text-right">CLV (Approx)</th>
                  <th className="px-6 py-3 text-right">Est. Edge</th>
                  <th className="px-6 py-3">Score</th>
                  <th className="px-6 py-3 text-right">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {safeBets.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-6 py-12 text-center text-gray-400">
                      No paper bets logged yet. Wait for the scanner to run.
                    </td>
                  </tr>
                )}

                {safeBets.map((bet) => (
                  <tr key={bet.id} className="hover:bg-blue-50 transition">
                    <td className="px-6 py-4 text-gray-400 text-xs">
                      {new Date(bet.timestamp).toLocaleString(undefined, {
                         month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
                      })}
                    </td>
                    <td className="px-6 py-4 font-medium text-gray-900">
                        {bet.match_name}
                    </td>
                    <td className="px-6 py-4">
                      {bet.selection}
                      {bet.handicap && <span className="text-gray-400 text-xs ml-1">({bet.handicap})</span>}
                      <div className="text-xs text-gray-400 mt-0.5">{bet.market_type}</div>
                    </td>
                    
                    <td className="px-6 py-4 text-right font-mono font-bold text-gray-800">
                        {bet.danske_odds.toFixed(2)}
                    </td>
                    <td className="px-6 py-4 text-right font-mono text-gray-500">
                        {bet.pinnacle_odds ? bet.pinnacle_odds.toFixed(2) : "-"}
                    </td>
                    <td className="px-6 py-4 text-right font-mono text-gray-500">
                        {bet.closing_odds ? (
                            <div>
                                {bet.closing_odds.toFixed(2)}
                                {(() => {
                                    // Logic: Is CLV lower than what we found? (That's good)
                                    // Wait, usually CLV comparison is: Did we beat the closing line?
                                    // Odds Taken (Danske) vs Closing Fair Odds.
                                    
                                    const clvVal = bet.closing_odds;
                                    const oddsTaken = bet.danske_odds;
                                    const clvPercent = ((oddsTaken / clvVal) - 1) * 100;
                                    const isGood = clvPercent > 0;
                                    
                                    return (
                                        <div className={`text-[10px] font-bold ${isGood ? "text-green-600" : "text-red-500"}`}>
                                        {isGood ? "Beat Line" : "Missed"} ({clvPercent > 0 ? "+" : ""}{clvPercent.toFixed(1)}%)
                                        </div>
                                    )
                                })()}
                            </div>
                        ) : "-"}
                    </td>
                    {/* EDGE COLUMN */}
                    <td className="px-6 py-4 text-right">
                        <span className={`px-2 py-0.5 rounded text-xs font-bold ${
                            bet.ev_percent > 5 ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-700"
                        }`}>
                            {bet.ev_percent.toFixed(1)}%
                        </span>
                    </td>

                    <td className="px-6 py-4 text-xs text-gray-500">
                      {bet.result_score || "-"}
                    </td>

                    <td className="px-6 py-4 text-right">
                      <span className={`px-2 py-1 rounded text-xs font-bold ${
                        bet.status === "Won" ? "bg-green-100 text-green-700" :
                        bet.status === "Lost" ? "bg-red-50 text-red-700 opacity-50" :
                        bet.status === "Void" ? "bg-yellow-50 text-yellow-700" :
                        "text-gray-400 italic"
                      }`}>
                        {bet.status === "Pending" ? "..." : bet.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </main>
  );
}