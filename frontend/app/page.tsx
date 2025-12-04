"use client";

import { useState, useEffect } from "react";
import BetModal from "../components/BetModal";;

// 1. Define the shape of our data (TypeScript Interface)
// This matches the JSON coming from your Python API
interface Opportunity {
  id: string;
  match: string;
  type: string;
  selection: string;
  line: number | null;
  danske_odds: number;
  fair_odds: number;
  ev: number;
}

interface ApiResponse {
  timestamp: string;
  count: number;
  data: Opportunity[];
}


export default function Home() {
  const [data, setData] = useState<Opportunity[]>([]);
  const [loading, setLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedBet, setSelectedBet] = useState<Opportunity | null>(null);
  const [bankroll, setBankroll] = useState(1000); // Default $1000

  // 1. When row is clicked, open modal
  const handleRowClick = (bet: Opportunity) => {
    setSelectedBet(bet);
  };

  // 2. When "Place Bet" is clicked inside modal
  const handleConfirmBet = async (stake: number) => {
    if (!selectedBet) return;

    try {
      const res = await fetch("http://127.0.0.1:8000/api/place-bet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          match_name: selectedBet.match,
          selection: selectedBet.selection,
          market_type: selectedBet.type,
          handicap: selectedBet.line,
          danske_odds: selectedBet.danske_odds,
          fair_odds: selectedBet.fair_odds,
          ev_percent: selectedBet.ev,
          stake: stake
        }),
      });

      if (res.ok) {
        // Close modal and maybe show a toast
        setSelectedBet(null);
        // Ideally, subtract from bankroll here locally for immediate feedback
        setBankroll(prev => prev - stake); 
        alert("Bet placed successfully!");
      } else {
        alert("Error placing bet");
      }
    } catch (err) {
      console.error(err);
      alert("Failed to connect");
    }
  };


  // 2. The Fetch Function
  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      // Note: We point to port 8000 where FastAPI is running
      const res = await fetch("http://127.0.0.1:8000/api/opportunities");
      
      if (!res.ok) {
        throw new Error("Failed to fetch data from backend");
      }

      const json: ApiResponse = await res.json();
      setData(json.data);
      
      // Format the timestamp nicely
      const date = new Date(json.timestamp);
      setLastUpdated(date.toLocaleTimeString());
      
    } catch (err) {
      console.error(err);
      setError("Error connecting to Python Backend. Is it running?");
    } finally {
      setLoading(false);
    }
  };

  // Fetch on initial load
  useEffect(() => {
    fetchData();
  }, []);

  // 3. Helper for Color Coding EV
  const getEvColor = (ev: number) => {
    if (ev >= 5) return "text-green-600 font-bold"; // Amazing
    if (ev > 0) return "text-green-500";            // Good
    return "text-gray-500";                         // Marginal
  };

  return (
    <main className="min-h-screen bg-gray-50 p-8 font-sans text-gray-900">
      <div className="max-w-6xl mx-auto">
        
        {/* HEADER */}
        <div className="flex justify-between items-center mb-8">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Market Scanner</h1>
            <p className="text-gray-500 mt-1">
              Comparing Danske Spil vs Pinnacle
            </p>
          </div>
          
          <div className="text-right">
            <button
              onClick={fetchData}
              disabled={loading}
              className="bg-black text-white px-4 py-2 rounded-md hover:bg-gray-800 disabled:opacity-50 transition"
            >
              {loading ? "Scanning..." : "Refresh Data"}
            </button>
            {lastUpdated && (
              <p className="text-xs text-gray-400 mt-2">
                Last fetched: {lastUpdated}
              </p>
            )}
          </div>
        </div>

        {/* ERROR STATE */}
        {error && (
          <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-6">
            {error}
          </div>
        )}

        {/* DATA TABLE */}
        <div className="bg-white shadow-sm rounded-lg border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="bg-gray-100 text-gray-600 font-medium border-b">
                <tr>
                  <th className="px-6 py-3">Match</th>
                  <th className="px-6 py-3">Selection</th>
                  <th className="px-6 py-3">Market</th>
                  <th className="px-6 py-3 text-right">Danske Odds</th>
                  <th className="px-6 py-3 text-right">Fair Odds</th>
                  <th className="px-6 py-3 text-right">EV (%)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {data.length === 0 && !loading && (
                  <tr>
                    <td colSpan={6} className="px-6 py-8 text-center text-gray-500">
                      No opportunities found (or waiting for data...)
                    </td>
                  </tr>
                )}
                
                {data.map((bet) => (
                  <tr 
                    key={bet.id} 
                    onClick={() => handleRowClick(bet)} // <--- ADD CLICK HANDLER
                    className="hover:bg-blue-50 transition cursor-pointer border-b last:border-0"
                  >
                    <td className="px-6 py-4 font-medium">{bet.match}</td>
                    <td className="px-6 py-4">
                      {bet.selection}
                      {bet.line && <span className="ml-2 text-gray-400 text-xs">({bet.line})</span>}
                    </td>
                    <td className="px-6 py-4 text-gray-500">{bet.type}</td>
                    <td className="px-6 py-4 text-right font-mono">{bet.danske_odds.toFixed(2)}</td>
                    <td className="px-6 py-4 text-right text-gray-400 font-mono">{bet.fair_odds.toFixed(2)}</td>
                    <td className={`px-6 py-4 text-right font-mono ${getEvColor(bet.ev)}`}>
                      {bet.ev > 0 ? "+" : ""}{bet.ev}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <BetModal 
        bet={selectedBet} 
        isOpen={!!selectedBet} 
        onClose={() => setSelectedBet(null)}
        onConfirm={handleConfirmBet}
        currentBankroll={bankroll}
      />

    {/* Optional: Bankroll Input in the Header */}
    {/* You can add a small input in the header to adjust the $1000 default */}

    </main>
  );
}