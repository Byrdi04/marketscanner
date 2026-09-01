"use client";

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";

interface PaperBet {
  id: number;
  match_name: string;
  selection: string;
  market_type: string;
  handicap: number | null;
  danske_odds: number;
  pinnacle_odds: number;
  closing_odds: number | null;
  ev_percent: number;
  status: string;
  result_score: string | null;
  timestamp: string;
  league?: string;
  commence_time?: string;
}

interface FilterState {
  marketType: string;
  status: string;
  minEv: string;
  maxEv: string;
  search: string;
  league: string;
  dateFrom: string;
  dateTo: string;
  minOdds: string;
  maxOdds: string;
  minHoursToStart: string;
  maxHoursToStart: string;
  minClv: string;
  maxClv: string;
}

const DEFAULT_FILTERS: FilterState = {
  marketType: "All",
  status: "All",
  minEv: "",
  maxEv: "",
  search: "",
  league: "All",
  dateFrom: "",
  dateTo: "",
  minOdds: "",
  maxOdds: "",
  minHoursToStart: "",
  maxHoursToStart: "",
  minClv: "",
  maxClv: "",
};

function getDropdownOptions(bets: PaperBet[]) {
  const marketTypes = Array.from(new Set(bets.map(b => b.market_type))).sort();
  const statuses = Array.from(new Set(bets.map(b => b.status))).sort();
  const leagues = Array.from(new Set(bets.map(b => (b.league || "NBA")))).sort();
  return { marketTypes, statuses, leagues };
}

function applyFilters(bets: PaperBet[], filters: FilterState): PaperBet[] {
  return bets.filter(b => {
    if (filters.marketType !== "All" && b.market_type !== filters.marketType) return false;
    if (filters.status !== "All" && b.status !== filters.status) return false;
    if (filters.league !== "All" && (b.league || "NBA") !== filters.league) return false;

    if (filters.minEv !== "") {
      const min = parseFloat(filters.minEv);
      if (!isNaN(min) && b.ev_percent < min) return false;
    }
    if (filters.maxEv !== "") {
      const max = parseFloat(filters.maxEv);
      if (!isNaN(max) && b.ev_percent > max) return false;
    }

    if (filters.search !== "") {
      const q = filters.search.toLowerCase();
      if (!b.match_name.toLowerCase().includes(q) && !b.selection.toLowerCase().includes(q)) return false;
    }

    if (filters.dateFrom !== "") {
      const from = new Date(filters.dateFrom);
      if (new Date(b.timestamp) < from) return false;
    }
    if (filters.dateTo !== "") {
      const to = new Date(filters.dateTo);
      to.setHours(23, 59, 59, 999);
      if (new Date(b.timestamp) > to) return false;
    }

    if (filters.minOdds !== "") {
      const min = parseFloat(filters.minOdds);
      if (!isNaN(min) && b.danske_odds < min) return false;
    }
    if (filters.maxOdds !== "") {
      const max = parseFloat(filters.maxOdds);
      if (!isNaN(max) && b.danske_odds > max) return false;
    }

    // Time to game start filter (hours between bet found and game start)
    if (b.commence_time && (filters.minHoursToStart !== "" || filters.maxHoursToStart !== "")) {
      const betTime = new Date(b.timestamp).getTime();
      const gameTime = new Date(b.commence_time).getTime();
      const hoursToStart = (gameTime - betTime) / (1000 * 60 * 60);
      if (filters.minHoursToStart !== "") {
        const min = parseFloat(filters.minHoursToStart);
        if (!isNaN(min) && hoursToStart < min) return false;
      }
      if (filters.maxHoursToStart !== "") {
        const max = parseFloat(filters.maxHoursToStart);
        if (!isNaN(max) && hoursToStart > max) return false;
      }
    }

    // CLV range filter (based on danske_odds / closing_odds - 1)
    if ((filters.minClv !== "" || filters.maxClv !== "") && b.closing_odds) {
      const clvPercent = ((b.danske_odds / b.closing_odds) - 1) * 100;
      if (filters.minClv !== "") {
        const min = parseFloat(filters.minClv);
        if (!isNaN(min) && clvPercent < min) return false;
      }
      if (filters.maxClv !== "") {
        const max = parseFloat(filters.maxClv);
        if (!isNaN(max) && clvPercent > max) return false;
      }
    } else if (filters.minClv !== "" || filters.maxClv !== "") {
      // Bet has no closing odds but a CLV filter is active — exclude it
      return false;
    }

    return true;
  });
}

export default function PaperTrading() {
  const [bets, setBets] = useState<PaperBet[]>([]);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [showMore, setShowMore] = useState(false);

  const fetchBets = async () => {
    try {
      const res = await fetch(`/api/paper-bets`);
      if (!res.ok) {
        console.error("Server error:", res.statusText);
        setBets([]);
        return;
      }
      const json = await res.json();
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

  const safeBets = useMemo(() => (Array.isArray(bets) ? bets : []), [bets]);
  const dropdownOptions = useMemo(() => getDropdownOptions(safeBets), [safeBets]);
  const filteredBets = useMemo(() => applyFilters(safeBets, filters), [safeBets, filters]);
  const filteredSettled = useMemo(() => filteredBets.filter(b => b.status !== "Pending"), [filteredBets]);
  const totalFiltered = filteredSettled.length;

  const unitsProfit = filteredSettled.reduce((sum, b) => {
    if (b.status === "Won") return sum + (b.danske_odds - 1);
    if (b.status === "Lost") return sum - 1;
    return sum;
  }, 0);

  const winRate = totalFiltered > 0
    ? (filteredSettled.filter(b => b.status === "Won").length / totalFiltered) * 100
    : 0;

  const roi = totalFiltered > 0 ? (unitsProfit / totalFiltered) * 100 : 0;

  const setFilter = (key: string, value: string) => {
    setFilters(prev => ({ ...prev, [key]: value }));
  };

  const resetFilters = () => {
    setFilters(DEFAULT_FILTERS);
  };

  const filterCount = Object.entries(filters).filter(([key, val]) => {
    if (["search", "minEv", "maxEv", "minOdds", "maxOdds", "dateFrom", "dateTo", "minHoursToStart", "maxHoursToStart", "minClv", "maxClv"].includes(key)) return val !== "";
    return val !== "All" && val !== "";
  }).length;

  const inputClass = "border border-gray-300 rounded px-2 py-1.5 text-xs text-gray-700 bg-white focus:outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400";
  const selectClass = "border border-gray-300 rounded px-2 py-1.5 text-xs text-gray-700 bg-white focus:outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400 cursor-pointer";

  const renderClv = (bet: PaperBet) => {
    if (!bet.closing_odds) return "-";
    const clvPercent = ((bet.danske_odds / bet.closing_odds) - 1) * 100;
    const isGood = clvPercent > 0;
    return (
      <div>
        <span className="text-gray-500">{bet.closing_odds.toFixed(2)}</span>
        <div className={`text-[10px] font-bold ${isGood ? "text-green-600" : "text-red-500"}`}>
          {isGood ? "Beat Line" : "Missed"} ({clvPercent > 0 ? "+" : ""}{clvPercent.toFixed(1)}%)
        </div>
      </div>
    );
  };

  return (
    <main className="min-h-screen bg-gray-50 p-8 font-sans text-gray-900">
      <div className="max-w-7xl mx-auto">

        {/* HEADER */}
        <div className="flex justify-between items-center mb-6">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Paper Trading</h1>
            <p className="text-sm text-gray-500 mt-1">Automated simulation of every edge found</p>
            <div className="flex gap-4 mt-4 text-sm font-medium">
              <Link href="/" className="text-gray-500 hover:text-black hover:underline">← Scanner</Link>
              <Link href="/portfolio" className="text-gray-500 hover:text-black hover:underline">Real Portfolio</Link>
            </div>
          </div>

          <div className="flex gap-4 items-center">
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

        {/* FILTER BAR */}
        <div className="bg-white border border-gray-200 rounded-lg shadow-sm p-4 mb-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1.5">
              <label className="text-[10px] text-gray-400 uppercase font-bold whitespace-nowrap">Market</label>
              <select
                className={selectClass}
                value={filters.marketType}
                onChange={e => setFilter("marketType", e.target.value)}
              >
                <option value="All">All</option>
                {dropdownOptions.marketTypes.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>

            <div className="flex items-center gap-1.5">
              <label className="text-[10px] text-gray-400 uppercase font-bold whitespace-nowrap">Status</label>
              <select
                className={selectClass}
                value={filters.status}
                onChange={e => setFilter("status", e.target.value)}
              >
                <option value="All">All</option>
                {dropdownOptions.statuses.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>

            <div className="flex items-center gap-1.5">
              <label className="text-[10px] text-gray-400 uppercase font-bold whitespace-nowrap">Min EV</label>
              <input
                type="number"
                step="0.1"
                placeholder="0"
                className={inputClass + " w-16"}
                value={filters.minEv}
                onChange={e => setFilter("minEv", e.target.value)}
              />
            </div>

            <div className="flex items-center gap-1.5">
              <label className="text-[10px] text-gray-400 uppercase font-bold whitespace-nowrap">Max EV</label>
              <input
                type="number"
                step="0.1"
                placeholder="100"
                className={inputClass + " w-16"}
                value={filters.maxEv}
                onChange={e => setFilter("maxEv", e.target.value)}
              />
            </div>

            <div className="flex items-center gap-1.5 flex-1 min-w-[140px]">
              <label className="text-[10px] text-gray-400 uppercase font-bold whitespace-nowrap">Search</label>
              <input
                type="text"
                placeholder="Match or selection..."
                className={inputClass + " w-full"}
                value={filters.search}
                onChange={e => setFilter("search", e.target.value)}
              />
            </div>

            <button
              onClick={() => setShowMore(!showMore)}
              className={`text-xs font-bold px-3 py-1.5 rounded border transition cursor-pointer ${
                showMore || filterCount > 0
                  ? "bg-blue-50 border-blue-300 text-blue-700"
                  : "bg-gray-50 border-gray-200 text-gray-500 hover:bg-gray-100"
              }`}
              title={showMore ? "Hide extra filters" : "Show extra filters"}
            >
              {showMore ? "− Less" : "+ More"}
              {filterCount > 0 && (
                <span className="ml-1 bg-blue-200 text-blue-800 text-[9px] rounded-full px-1.5 py-0.5">
                  {filterCount}
                </span>
              )}
            </button>

            {filterCount > 0 && (
              <button
                onClick={resetFilters}
                className="text-xs text-gray-400 hover:text-red-500 underline cursor-pointer"
              >
                Clear
              </button>
            )}
          </div>

          {showMore && (
            <div className="flex flex-wrap items-center gap-3 mt-3 pt-3 border-t border-gray-100">
              <div className="flex items-center gap-1.5">
                <label className="text-[10px] text-gray-400 uppercase font-bold whitespace-nowrap">League</label>
                <select
                  className={selectClass}
                  value={filters.league}
                  onChange={e => setFilter("league", e.target.value)}
                >
                  <option value="All">All</option>
                  {dropdownOptions.leagues.map(l => <option key={l} value={l}>{l}</option>)}
                </select>
              </div>

              <div className="flex items-center gap-1.5">
                <label className="text-[10px] text-gray-400 uppercase font-bold whitespace-nowrap">From</label>
                <input
                  type="date"
                  className={inputClass}
                  value={filters.dateFrom}
                  onChange={e => setFilter("dateFrom", e.target.value)}
                />
              </div>

              <div className="flex items-center gap-1.5">
                <label className="text-[10px] text-gray-400 uppercase font-bold whitespace-nowrap">To</label>
                <input
                  type="date"
                  className={inputClass}
                  value={filters.dateTo}
                  onChange={e => setFilter("dateTo", e.target.value)}
                />
              </div>

              <div className="flex items-center gap-1.5">
                <label className="text-[10px] text-gray-400 uppercase font-bold whitespace-nowrap">Min Odds</label>
                <input
                  type="number"
                  step="0.01"
                  placeholder="1.00"
                  className={inputClass + " w-16"}
                  value={filters.minOdds}
                  onChange={e => setFilter("minOdds", e.target.value)}
                />
              </div>

              <div className="flex items-center gap-1.5">
                <label className="text-[10px] text-gray-400 uppercase font-bold whitespace-nowrap">Max Odds</label>
                <input
                  type="number"
                  step="0.01"
                  placeholder="10.00"
                  className={inputClass + " w-16"}
                  value={filters.maxOdds}
                  onChange={e => setFilter("maxOdds", e.target.value)}
                />
              </div>

              {/* Hours to Game Start */}
              <div className="flex items-center gap-1.5">
                <label className="text-[10px] text-gray-400 uppercase font-bold whitespace-nowrap">Game In (h)</label>
                <input
                  type="number"
                  step="0.5"
                  placeholder="Min"
                  className={inputClass + " w-14"}
                  value={filters.minHoursToStart}
                  onChange={e => setFilter("minHoursToStart", e.target.value)}
                />
                <span className="text-[10px] text-gray-300">–</span>
                <input
                  type="number"
                  step="0.5"
                  placeholder="Max"
                  className={inputClass + " w-14"}
                  value={filters.maxHoursToStart}
                  onChange={e => setFilter("maxHoursToStart", e.target.value)}
                />
              </div>

              {/* CLV Range */}
              <div className="flex items-center gap-1.5">
                <label className="text-[10px] text-gray-400 uppercase font-bold whitespace-nowrap">CLV %</label>
                <input
                  type="number"
                  step="0.1"
                  placeholder="Min"
                  className={inputClass + " w-14"}
                  value={filters.minClv}
                  onChange={e => setFilter("minClv", e.target.value)}
                />
                <span className="text-[10px] text-gray-300">–</span>
                <input
                  type="number"
                  step="0.1"
                  placeholder="Max"
                  className={inputClass + " w-14"}
                  value={filters.maxClv}
                  onChange={e => setFilter("maxClv", e.target.value)}
                />
              </div>
            </div>
          )}
        </div>

        {/* TABLE */}
        <div className="bg-white shadow rounded-lg overflow-hidden border border-gray-200">
          <div className="px-6 py-2 bg-gray-50 border-b border-gray-200 text-xs text-gray-500">
            Showing {filteredBets.length} of {safeBets.length} bets
            {filteredBets.length !== safeBets.length && (
              <span className="ml-2">
                — {filteredSettled.length} settled,{" "}
                {unitsProfit >= 0 ? "+" : ""}{unitsProfit.toFixed(2)}u profit,{" "}
                {roi.toFixed(1)}% ROI, {winRate.toFixed(1)}% WR
              </span>
            )}
          </div>

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
                {filteredBets.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-6 py-12 text-center text-gray-400">
                      {safeBets.length === 0
                        ? "No paper bets logged yet. Wait for the scanner to run."
                        : "No bets match your filters."}
                    </td>
                  </tr>
                )}

                {filteredBets.map((bet) => (
                  <tr key={bet.id} className="hover:bg-blue-50 transition">
                    <td className="px-6 py-4 text-gray-400 text-xs">
                      {new Date(bet.timestamp).toLocaleString(undefined, {
                        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
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
                      {renderClv(bet)}
                    </td>
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
