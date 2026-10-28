"use client";

import { useState, useEffect } from "react";
import BetModal from "../components/BetModal";

// INTERFACES
interface Opportunity {
  id: string;
  event_id: number;
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
  const [minEv, setMinEv] = useState(3.5); // Default: Only show > 2% EV
  const [hidePlaced, setHidePlaced] = useState(false); // Toggle to hide placed bets

  // 1. FETCH SCANNER DATA
  const fetchScanner = async (isManualRefresh = true) => {
    setLoading(true);
    try {
      // Pass the parameter to the backend
      // If isManualRefresh is true, ?refresh=true. Else ?refresh=false
      const res = await fetch(`/api/opportunities?refresh=${isManualRefresh}`);
      
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
      const res = await fetch(`/api/my-bets`);
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
      const res = await fetch(`/api/place-bet`, {
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
          stake: stake,
          commence_time: selectedBet.commence_time
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
    if (dataAge === 0) return { color: "bg-slate-500", text: "Unknown" };

    const now = Math.floor(Date.now() / 1000);
    const diffMinutes = Math.floor((now - dataAge) / 60);

    if (diffMinutes < 5) return { color: "bg-emerald-400", text: "Fresh (< 5m)" };
    if (diffMinutes < 15) return { color: "bg-amber-400", text: `Aging (${diffMinutes}m)` };
    return { color: "bg-rose-400", text: `Stale (${diffMinutes}m)` };
  };

  // Helper: Format start time
  const formatStartTime = (isoString: string) => {
    const start = new Date(isoString);
    const now = new Date();
    const diffMs = start.getTime() - now.getTime();
    const diffHrs = diffMs / (1000 * 60 * 60);

    // If started or starting in 10 mins
    if (diffHrs < 0) return <span className="font-bold text-rose-400">Live / Started</span>;
    if (diffHrs < 1) return <span className="font-bold text-amber-300">In {Math.floor(diffHrs * 60)}m</span>;
    if (diffHrs < 24) return <span className="text-slate-300">In {Math.floor(diffHrs)}h</span>;
    return <span className="text-slate-500">{start.toLocaleDateString()}</span>;
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
    if (ev >= 5) return "font-bold text-emerald-400";
    if (ev > 0) return "text-emerald-400/80";
    return "text-slate-500";
  };

  return (
    <main className="min-h-screen bg-slate-950 font-sans text-slate-100">
      <div className="mx-auto max-w-7xl px-4 py-6 md:px-6 lg:py-8">
        {/* HEADER */}
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-50 sm:text-3xl">
              Live EV Scanner
            </h1>
            <p className="mt-1 text-sm text-slate-400">
              Soft odds found where Danske Spil diverges from Pinnacle
            </p>
          </div>

          <div className="flex flex-wrap items-end gap-3 sm:flex-col sm:items-end sm:gap-2">
            <button
              onClick={() => fetchScanner(true)}
              disabled={loading}
              className="btn btn-primary"
            >
              {loading ? (
                <>
                  <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-950/40 border-t-slate-950" />
                  Scanning…
                </>
              ) : (
                <>
                  <svg
                    className="h-4 w-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                    <path d="M21 3v6h-6" />
                  </svg>
                  Refresh Data
                </>
              )}
            </button>

            <div className="flex flex-col items-start gap-1 text-right text-xs text-slate-400 sm:items-end">
              <span>Updated: {lastUpdated || "-"}</span>
              <span className="font-mono">API Credits: {quota}</span>

              {/* STALENESS INDICATOR */}
              <span className="flex items-center gap-2">
                <span>Pinnacle Data:</span>
                <span className={`inline-block h-2 w-2 rounded-full ${getStalenessInfo().color}`} />
                <span className="font-medium text-slate-300">{getStalenessInfo().text}</span>
              </span>
            </div>
          </div>
        </div>

        {/* FILTERS BAR */}
        <div className="card mb-6 flex flex-wrap items-center gap-x-6 gap-y-4 px-4 py-4">
          {/* Min EV Slider */}
          <div className="flex items-center gap-3">
            <label className="min-w-[110px] text-sm font-medium text-slate-300">
              {minEv <= -5 ? "Filter: Off" : `Min EV: ${minEv}%`}
            </label>
            <input
              type="range"
              min="-10" // Allow dragging below 0
              max="10"
              step="0.5"
              value={minEv}
              onChange={(e) => setMinEv(parseFloat(e.target.value))}
              className="w-32 cursor-pointer accent-emerald-500"
            />
          </div>

          {/* Toggle Hide Placed */}
          <label className="flex cursor-pointer select-none items-center gap-2">
            <input
              type="checkbox"
              id="hidePlaced"
              checked={hidePlaced}
              onChange={(e) => setHidePlaced(e.target.checked)}
              className="h-4 w-4 rounded accent-emerald-500"
            />
            <span className="text-sm text-slate-300">Hide Already Placed</span>
          </label>

          <div className="ml-auto text-xs text-slate-500">
            Showing <span className="font-medium text-slate-300">{filteredData.length}</span> of{" "}
            {scannerData.length} opportunities
          </div>
        </div>

        {/* DATA TABLE */}
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="data-table text-sm">
              <thead className="border-b border-slate-700/80 bg-slate-900/80 font-semibold text-slate-400">
                <tr>
                  <th className="px-5 py-3">Match</th>
                  <th className="px-5 py-3">Start</th>
                  <th className="px-5 py-3">Selection</th>
                  <th className="px-5 py-3">Market</th>
                  <th className="px-5 py-3 text-right">Danske</th>
                  <th className="px-5 py-3 text-right">Fair</th>
                  <th className="px-5 py-3 text-right">EV</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {filteredData.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-5 py-10 text-center text-slate-500">
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
                      className={`transition-colors last:border-0 ${
                        placed
                          ? "cursor-not-allowed bg-slate-900/40 opacity-50"
                          : "cursor-pointer hover:bg-slate-800/50"
                      }`}
                    >
                      <td data-label="Match" className="px-5 py-4 font-medium text-slate-100">
                        {bet.match}
                        {/* Exposure Warning Badge */}
                        {exposure && (
                          <span
                            className="ml-2 inline-block rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300"
                            title="You already have a bet on this match"
                          >
                            ⚠ Exposure
                          </span>
                        )}
                      </td>
                      <td data-label="Start" className="px-5 py-4 text-sm whitespace-nowrap">
                        {formatStartTime(bet.commence_time)}
                      </td>
                      <td data-label="Selection" className="px-5 py-4">
                        {bet.selection}
                        {bet.line != null && (
                          <span className="ml-2 text-xs text-slate-500">({bet.line})</span>
                        )}
                        {placed && (
                          <span className="ml-2 inline-block rounded border border-emerald-500/30 bg-emerald-500/10 px-1 text-xs font-bold text-emerald-300">
                            ✓ Placed
                          </span>
                        )}
                      </td>
                      <td data-label="Market" className="px-5 py-4 text-slate-400">
                        {bet.type}
                      </td>
                      <td data-label="Danske" className="px-5 py-4 text-right font-mono text-slate-200">
                        {bet.danske_odds.toFixed(2)}
                      </td>
                      <td data-label="Fair" className="px-5 py-4 text-right font-mono text-slate-500">
                        {bet.fair_odds.toFixed(2)}
                      </td>
                      <td
                        data-label="EV"
                        className={`px-5 py-4 text-right font-mono ${getEvColor(bet.ev)}`}
                      >
                        {bet.ev > 0 ? "+" : ""}
                        {bet.ev}%
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