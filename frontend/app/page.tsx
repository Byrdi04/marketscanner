"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import BetModal from "../components/BetModal";

// INTERFACES
interface Opportunity {
  id: string;
  match: string;
  type: string;
  selection: string;
  line: number | null;
  danske_odds: number;
  fair_odds: number;
  ev: number;
  commence_time: string;
}

interface PlacedBet {
  match_name: string;
  selection: string;
  market_type: string;
  handicap: number | null;
}

interface ApiResponse {
  timestamp: string;
  pinnacle_age: number;
  quota_remaining: string;
  count: number;
  data: Opportunity[];
}

export default function Home() {
  // DATA STATE
  const [scannerData, setScannerData] = useState<Opportunity[]>([]);
  const [placedBets, setPlacedBets] = useState<PlacedBet[]>([]); // NEW: specific list for checking
  const [loading, setLoading] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [quota, setQuota] = useState<string>("?");
  const [dataAge, setDataAge] = useState<number>(0); // Unix timestamp from backend
  
  // UI STATE
  const [selectedBet, setSelectedBet] = useState<Opportunity | null>(null);
  const [bankroll, setBankroll] = useState(1000);
  const [minEv, setMinEv] = useState(2); // Default: Only show > 2% EV
  const [hidePlaced, setHidePlaced] = useState(false); // Toggle to hide placed bets

  // 1. FETCH SCANNER DATA
  const fetchScanner = async (isManualRefresh = true) => {
    setLoading(true);
    try {
      // Pass the parameter to the backend
      // If isManualRefresh is true, ?refresh=true. Else ?refresh=false
      const res = await fetch(`http://127.0.0.1:8000/api/opportunities?refresh=${isManualRefresh}`);
      
      const json: ApiResponse = await res.json();
      setScannerData(json.data);
      setLastUpdated(new Date(json.timestamp).toLocaleTimeString());
      setDataAge(json.pinnacle_age);
      setQuota(json.quota_remaining);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  // 2. FETCH PLACED BETS (To check for duplicates)
  const fetchPlacedBets = async () => {
    try {
      const res = await fetch("http://127.0.0.1:8000/api/my-bets");
      const json = await res.json();
      setPlacedBets(json.data);
    } catch (err) {
      console.error("Error fetching placed bets");
    }
  };

  // Load both on startup
  useEffect(() => {
    fetchScanner(false); // <--- FALSE: Load stale data if available
    fetchPlacedBets();
  }, []);

  // 3. HELPER: CHECK IF BET IS PLACED
  const isBetPlaced = (op: Opportunity) => {
    return placedBets.some(pb => 
      pb.match_name === op.match &&
      pb.selection === op.selection &&
      pb.market_type === op.type &&
      // Handle loose float matching for lines
      (pb.handicap === op.line || (pb.handicap === null && op.line === null))
    );
  };

  // 4. HELPER: CHECK FOR MATCH EXPOSURE (Smart Strategy)
  // Returns true if we have ANY bet on this match, even a different market
  const hasMatchExposure = (op: Opportunity) => {
    return placedBets.some(pb => pb.match_name === op.match);
  };

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
        setSelectedBet(null);
        // Refresh placed bets so the UI updates instantly
        fetchPlacedBets(); 
        alert("Bet placed!");
      }
    } catch (err) {
      alert("Failed to connect");
    }
  };

    // Helper: Calculate minutes since Pinnacle update
  const getStalenessInfo = () => {
    if (dataAge === 0) return { color: "bg-gray-400", text: "Unknown" };
    
    const now = Math.floor(Date.now() / 1000);
    const diffMinutes = Math.floor((now - dataAge) / 60);
    
    if (diffMinutes < 5) return { color: "bg-green-500", text: "Fresh (< 5m)" };
    if (diffMinutes < 15) return { color: "bg-yellow-500", text: `Aging (${diffMinutes}m)` };
    return { color: "bg-red-500", text: `Stale (${diffMinutes}m)` };
  };

  // Helper: Format start time
  const formatStartTime = (isoString: string) => {
    const start = new Date(isoString);
    const now = new Date();
    const diffMs = start.getTime() - now.getTime();
    const diffHrs = diffMs / (1000 * 60 * 60);
    
    // If started or starting in 10 mins
    if (diffHrs < 0) return <span className="text-red-600 font-bold">Live / Started</span>;
    if (diffHrs < 1) return <span className="text-orange-600 font-bold">In {Math.floor(diffHrs * 60)}m</span>;
    if (diffHrs < 24) return <span className="text-gray-700">In {Math.floor(diffHrs)}h</span>;
    return <span className="text-gray-400">{start.toLocaleDateString()}</span>;
  };

  // 5. FILTER LOGIC
  const filteredData = scannerData.filter(bet => {
    // A. EV Filter
    if (bet.ev < minEv) return false;
    // B. Hide Placed Filter
    if (hidePlaced && isBetPlaced(bet)) return false;
    return true;
  });

  const getEvColor = (ev: number) => {
    if (ev >= 5) return "text-green-600 font-bold";
    if (ev > 0) return "text-green-500";
    return "text-gray-500";
  };

  return (
    <main className="min-h-screen bg-gray-50 p-8 font-sans text-gray-900">
      <div className="max-w-6xl mx-auto">
        
        {/* HEADER */}
        <div className="flex justify-between items-start mb-8">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Market Scanner</h1>
            <div className="flex gap-4 mt-1 text-sm">
              <p className="text-gray-500">Live EV Finder</p>
              <Link href="/portfolio" className="text-blue-600 hover:underline font-medium">
                View Portfolio →
              </Link>
            </div>
          </div>
          
          <div className="text-right">
            <button
              onClick={() => fetchScanner(true)}
              disabled={loading}
              className="..."
            >
              {loading ? "Scanning..." : "Refresh Data"}
            </button>
            <div className="mt-2 flex flex-col items-end text-xs text-gray-400">
              <span>Updated: {lastUpdated || "-"}</span>
              <span className="font-mono mt-1">API Credits: {quota}</span>

              {/* STALENESS INDICATOR */}
              <div className="flex items-center gap-2">
                <span>Pinnacle Data:</span>
                <span className={`w-2 h-2 rounded-full ${getStalenessInfo().color}`}></span>
                <span className="font-medium">{getStalenessInfo().text}</span>
              </div>
            </div>
          </div>
        </div>

        {/* FILTERS BAR */}
        <div className="bg-white p-4 rounded-lg shadow-sm border border-gray-200 mb-6 flex flex-wrap gap-6 items-center">
          
          {/* Min EV Slider */}
          <div className="flex items-center gap-3">
            <label className="text-sm font-medium text-gray-700">Min EV: {minEv}%</label>
            <input 
              type="range" min="0" max="10" step="0.5"
              value={minEv} onChange={(e) => setMinEv(parseFloat(e.target.value))}
              className="w-32 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-black"
            />
          </div>

          {/* Toggle Hide Placed */}
          <div className="flex items-center gap-2">
            <input 
              type="checkbox" 
              id="hidePlaced"
              checked={hidePlaced}
              onChange={(e) => setHidePlaced(e.target.checked)}
              className="w-4 h-4 text-black rounded focus:ring-black"
            />
            <label htmlFor="hidePlaced" className="text-sm text-gray-700 cursor-pointer select-none">
              Hide Already Placed
            </label>
          </div>

          <div className="ml-auto text-xs text-gray-400">
            Showing {filteredData.length} of {scannerData.length} opportunities
          </div>
        </div>

        {/* DATA TABLE */}
        <div className="bg-white shadow-sm rounded-lg border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="bg-gray-100 text-gray-600 font-medium border-b">
                <tr>
                  <th className="px-6 py-3">Match</th>
                  <th className="px-6 py-3">Start</th>
                  <th className="px-6 py-3">Selection</th>
                  <th className="px-6 py-3">Market</th>
                  <th className="px-6 py-3 text-right">Danske</th>
                  <th className="px-6 py-3 text-right">Fair</th>
                  <th className="px-6 py-3 text-right">EV</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {filteredData.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-6 py-8 text-center text-gray-500">
                      No bets match your filters.
                    </td>
                  </tr>
                )}
                
                {filteredData.map((bet) => {
                  const placed = isBetPlaced(bet);
                  const exposure = !placed && hasMatchExposure(bet); // Only show exposure warning if not already placed

                  return (
                    <tr 
                      key={bet.id} 
                      onClick={() => !placed && setSelectedBet(bet)}
                      className={`
                        transition border-b last:border-0
                        ${placed ? "bg-gray-50 opacity-60 cursor-not-allowed" : "hover:bg-blue-50 cursor-pointer"}
                      `}
                    >
                      <td className="px-6 py-4 font-medium">
                        {bet.match}
                        {/* Exposure Warning Badge */}
                        {exposure && (
                          <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] bg-orange-100 text-orange-700 border border-orange-200" title="You already have a bet on this match">
                            ⚠ Exposure
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-sm whitespace-nowrap">
                        {formatStartTime(bet.commence_time)}
                      </td>
                      <td className="px-6 py-4">
                        {bet.selection}
                        {bet.line && <span className="ml-2 text-gray-400 text-xs">({bet.line})</span>}
                        {placed && (
                          <span className="ml-2 text-xs font-bold text-green-600 border border-green-200 bg-green-50 px-1 rounded">
                            ✓ Placed
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-gray-500">{bet.type}</td>
                      <td className="px-6 py-4 text-right font-mono">{bet.danske_odds.toFixed(2)}</td>
                      <td className="px-6 py-4 text-right text-gray-400 font-mono">{bet.fair_odds.toFixed(2)}</td>
                      <td className={`px-6 py-4 text-right font-mono ${getEvColor(bet.ev)}`}>
                        +{bet.ev}%
                      </td>
                    </tr>
                  );
                })}
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
    </main>
  );
}