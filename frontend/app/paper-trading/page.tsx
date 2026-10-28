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

  const inputClass =
    "rounded-lg border border-slate-700 bg-slate-800/70 px-2 py-1.5 text-xs text-slate-100 placeholder-slate-500 outline-none transition focus:border-emerald-500/60 focus:ring-1 focus:ring-emerald-500/30 [color-scheme:dark]";
  const selectClass = inputClass + " cursor-pointer";

  const renderClv = (bet: PaperBet) => {
    if (!bet.closing_odds) return "-";
    const clvPercent = ((bet.danske_odds / bet.closing_odds) - 1) * 100;
    const isGood = clvPercent > 0;
    return (
      <div>
        <span className="text-slate-500">{bet.closing_odds.toFixed(2)}</span>
        <div className={`text-[10px] font-bold ${isGood ? "text-emerald-400" : "text-rose-400"}`}>
          {isGood ? "Beat Line" : "Missed"} ({clvPercent > 0 ? "+" : ""}
          {clvPercent.toFixed(1)}%)
        </div>
      </div>
    );
  };

  return (
    <main className="min-h-screen bg-slate-950 font-sans text-slate-100">
      <div className="mx-auto max-w-7xl px-4 py-6 md:px-6 lg:py-8">

        {/* HEADER */}
        <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-50 sm:text-3xl">
              Paper Trading
            </h1>
            <p className="mt-1 text-sm text-slate-400">
              Automated simulation of every edge found
            </p>
            <div className="mt-4 flex flex-wrap gap-3 text-sm font-medium">
              <Link href="/" className="text-slate-400 hover:text-slate-100 hover:underline">
                ← Scanner
              </Link>
              <Link href="/portfolio" className="text-slate-400 hover:text-slate-100 hover:underline">
                Real Portfolio
              </Link>
            </div>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="card px-4 py-2.5 text-right">
              <div className="label-sm">Simulated Profit</div>
              <div
                className={`font-mono text-xl font-bold ${
                  unitsProfit >= 0 ? "text-emerald-400" : "text-rose-400"
                }`}
              >
                {unitsProfit > 0 ? "+" : ""}
                {unitsProfit.toFixed(2)} u
              </div>
              <div className="text-xs text-slate-500">
                ROI: {roi.toFixed(1)}% | WR: {winRate.toFixed(1)}%
              </div>
            </div>

            <button onClick={handleForceSettle} disabled={loading} className="btn btn-ghost">
              {loading ? "Syncing…" : "Force Sync Results"}
            </button>
          </div>
        </div>

        {/* FILTER BAR */}
        <div className="card mb-4 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1.5">
              <label className="text-[10px] text-slate-500 uppercase font-bold whitespace-nowrap">Market</label>
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
              <label className="text-[10px] text-slate-500 uppercase font-bold whitespace-nowrap">Status</label>
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
              <label className="text-[10px] text-slate-500 uppercase font-bold whitespace-nowrap">Min EV</label>
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
              <label className="text-[10px] text-slate-500 uppercase font-bold whitespace-nowrap">Max EV</label>
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
              <label className="text-[10px] text-slate-500 uppercase font-bold whitespace-nowrap">Search</label>
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
                  ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
                  : "bg-slate-800/40 border-slate-700 text-slate-500 hover:bg-slate-800/70"
              }`}
              title={showMore ? "Hide extra filters" : "Show extra filters"}
            >
              {showMore ? "− Less" : "+ More"}
              {filterCount > 0 && (
                <span className="ml-1 bg-emerald-500/20 text-emerald-200 text-[9px] rounded-full px-1.5 py-0.5">
                  {filterCount}
                </span>
              )}
            </button>

            {filterCount > 0 && (
              <button
                onClick={resetFilters}
                className="text-xs text-slate-500 hover:text-rose-400 underline cursor-pointer"
              >
                Clear
              </button>
            )}
          </div>

          {showMore && (
            <div className="flex flex-wrap items-center gap-3 mt-3 pt-3 border-t border-slate-800">
              <div className="flex items-center gap-1.5">
                <label className="text-[10px] text-slate-500 uppercase font-bold whitespace-nowrap">League</label>
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
                <label className="text-[10px] text-slate-500 uppercase font-bold whitespace-nowrap">From</label>
                <input
                  type="date"
                  className={inputClass}
                  value={filters.dateFrom}
                  onChange={e => setFilter("dateFrom", e.target.value)}
                />
              </div>

              <div className="flex items-center gap-1.5">
                <label className="text-[10px] text-slate-500 uppercase font-bold whitespace-nowrap">To</label>
                <input
                  type="date"
                  className={inputClass}
                  value={filters.dateTo}
                  onChange={e => setFilter("dateTo", e.target.value)}
                />
              </div>

              <div className="flex items-center gap-1.5">
                <label className="text-[10px] text-slate-500 uppercase font-bold whitespace-nowrap">Min Odds</label>
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
                <label className="text-[10px] text-slate-500 uppercase font-bold whitespace-nowrap">Max Odds</label>
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
                <label className="text-[10px] text-slate-500 uppercase font-bold whitespace-nowrap">Game In (h)</label>
                <input
                  type="number"
                  step="0.5"
                  placeholder="Min"
                  className={inputClass + " w-14"}
                  value={filters.minHoursToStart}
                  onChange={e => setFilter("minHoursToStart", e.target.value)}
                />
                <span className="text-[10px] text-slate-600">–</span>
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
                <label className="text-[10px] text-slate-500 uppercase font-bold whitespace-nowrap">CLV %</label>
                <input
                  type="number"
                  step="0.1"
                  placeholder="Min"
                  className={inputClass + " w-14"}
                  value={filters.minClv}
                  onChange={e => setFilter("minClv", e.target.value)}
                />
                <span className="text-[10px] text-slate-600">–</span>
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
        <div className="card overflow-hidden">
          <div className="border-b border-slate-800 bg-slate-900/60 px-5 py-2 text-xs text-slate-500">
            Showing <span className="font-medium text-slate-300">{filteredBets.length}</span> of{" "}
            {safeBets.length} bets
            {filteredBets.length !== safeBets.length && (
              <span className="ml-2">
                — {filteredSettled.length} settled,{" "}
                <span className={unitsProfit >= 0 ? "text-emerald-400" : "text-rose-400"}>
                  {unitsProfit >= 0 ? "+" : ""}
                  {unitsProfit.toFixed(2)}u profit
                </span>
                , {roi.toFixed(1)}% ROI, {winRate.toFixed(1)}% WR
              </span>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="data-table text-sm">
              <thead className="border-b border-slate-700/80 bg-slate-900/80 font-semibold text-slate-400">
                <tr>
                  <th className="px-5 py-3">Found At</th>
                  <th className="px-5 py-3">Match</th>
                  <th className="px-5 py-3">Selection</th>
                  <th className="px-5 py-3 text-right">Danske (Soft)</th>
                  <th className="px-5 py-3 text-right">Pinnacle (Fair)</th>
                  <th className="px-5 py-3 text-right">CLV (Approx)</th>
                  <th className="px-5 py-3 text-right">Est. Edge</th>
                  <th className="px-5 py-3">Score</th>
                  <th className="px-5 py-3 text-right">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {filteredBets.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-5 py-12 text-center text-slate-500">
                      {safeBets.length === 0
                        ? "No paper bets logged yet. Wait for the scanner to run."
                        : "No bets match your filters."}
                    </td>
                  </tr>
                )}

                {filteredBets.map((bet) => (
                  <tr key={bet.id} className="transition-colors hover:bg-slate-800/40">
                    <td data-label="Found" className="px-5 py-4 text-xs text-slate-500">
                      {new Date(bet.timestamp).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </td>
                    <td data-label="Match" className="px-5 py-4 font-medium text-slate-100">
                      {bet.match_name}
                    </td>
                    <td data-label="Selection" className="px-5 py-4">
                      {bet.selection}
                      {bet.handicap && (
                        <span className="ml-1 text-xs text-slate-500">({bet.handicap})</span>
                      )}
                      <div className="mt-0.5 text-xs text-slate-500">{bet.market_type}</div>
                    </td>
                    <td
                      data-label="Danske"
                      className="px-5 py-4 text-right font-mono font-bold text-slate-100"
                    >
                      {bet.danske_odds.toFixed(2)}
                    </td>
                    <td data-label="Pinnacle" className="px-5 py-4 text-right font-mono text-slate-500">
                      {bet.pinnacle_odds ? bet.pinnacle_odds.toFixed(2) : "-"}
                    </td>
                    <td data-label="CLV" className="px-5 py-4 text-right font-mono text-slate-400">
                      {renderClv(bet)}
                    </td>
                    <td data-label="Est. Edge" className="px-5 py-4 text-right">
                      <span
                        className={`inline-block rounded px-2 py-0.5 text-xs font-bold ${
                          bet.ev_percent > 5
                            ? "bg-emerald-500/10 text-emerald-300"
                            : "bg-slate-800 text-slate-300"
                        }`}
                      >
                        {bet.ev_percent.toFixed(1)}%
                      </span>
                    </td>
                    <td data-label="Score" className="px-5 py-4 text-xs text-slate-500">
                      {bet.result_score || "-"}
                    </td>
                    <td data-label="Result" className="px-5 py-4 text-right">
                      <span
                        className={`inline-block rounded px-2 py-1 text-xs font-bold ${
                          bet.status === "Won"
                            ? "bg-emerald-500/10 text-emerald-300"
                            : bet.status === "Lost"
                              ? "bg-rose-500/10 text-rose-300 opacity-70"
                              : bet.status === "Void"
                                ? "bg-amber-500/10 text-amber-300"
                                : "italic text-slate-500"
                        }`}
                      >
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
