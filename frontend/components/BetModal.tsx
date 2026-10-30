"use client";

import { useState, useEffect, useRef } from "react";

interface BetModalProps {
  bet: any;
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (stake: number) => void;
  currentBankroll: number;
  defaultKellyFraction?: number;
  bankrollConfigured?: boolean;
}

// YOUR CUSTOM ROUNDING LOGIC (DKK)
const getSmartRoundedStake = (rawStake: number) => {
  if (rawStake <= 0) return 0;
  if (rawStake < 20) return Math.round(rawStake / 5) * 5; 
  if (rawStake < 100) return Math.round(rawStake / 10) * 10;
  if (rawStake < 500) return Math.round(rawStake / 25) * 25;
  return Math.round(rawStake / 50) * 50;
};

export default function BetModal({
  bet,
  isOpen,
  onClose,
  onConfirm,
  currentBankroll,
  defaultKellyFraction = 0.5,
  bankrollConfigured = true,
}: BetModalProps) {
  const [stake, setStake] = useState<string>("");
  const [fraction, setFraction] = useState<number>(defaultKellyFraction);
  const [copied, setCopied] = useState(false); // State for clipboard feedback
  const prevOpen = useRef(false);

  // Reset the Kelly fraction to the saved default each time the modal opens
  useEffect(() => {
    if (isOpen && !prevOpen.current) {
      setFraction(defaultKellyFraction);
    }
    prevOpen.current = isOpen;
  }, [isOpen, defaultKellyFraction]);

  // SAFE CALCULATIONS
  const b = bet ? bet.danske_odds - 1 : 0;
  const evDecimal = bet ? bet.ev / 100 : 0;
  const fullKellyPercent = b > 0 ? evDecimal / b : 0;
  
  const adjustedKellyPercent = fullKellyPercent * fraction;
  const rawStake = currentBankroll * adjustedKellyPercent;
  const suggestedStake = getSmartRoundedStake(rawStake);

  const isHighEv = bet && bet.ev > 15; 

  useEffect(() => {
    if (isOpen && bet && suggestedStake > 0) {
      setStake(suggestedStake.toString());
      setCopied(false); // Reset copy status when opening new bet
    }
  }, [bet, fraction, currentBankroll, isOpen, suggestedStake]);

  if (!isOpen || !bet) return null;

  // --- CLIPBOARD LOGIC ---
  const handleLinkClick = () => {
    if (bet.line !== null && bet.line !== undefined) {
      // 1. Convert line to string and replace dot with comma (DKK format)
      // Example: -9.5 becomes "-9,5"
      const searchTerm = bet.line.toString().replace('.', '.');
      
      // 2. Write to clipboard
      navigator.clipboard.writeText(searchTerm).then(() => {
        setCopied(true);
        // Hide "Copied" message after 3 seconds
        setTimeout(() => setCopied(false), 3000);
      });
    }
  };

  // VALIDATION: Ensure stake is a number greater than 0
  const isStakeValid = stake !== "" && !isNaN(parseFloat(stake)) && parseFloat(stake) > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-3 backdrop-blur-sm sm:p-4">
      <div className="max-h-[88dvh] w-full max-w-md overflow-y-auto rounded-2xl border border-slate-700/70 bg-slate-900 p-5 shadow-2xl shadow-black/50 sm:p-6">
        {/* HEADER */}
        <div className="mb-5 flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            {/* MATCH INFO */}
            <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-slate-500">
              {bet.match}
            </p>

            {/* SELECTION + LINE BADGE */}
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-2xl font-bold text-slate-50">{bet.selection}</h2>

              {/* VISUAL BADGE FOR LINE */}
              {bet.line && (
                <span className="rounded border border-slate-600 bg-slate-700/60 px-2 py-0.5 font-mono text-sm text-slate-200">
                  {bet.type}: {bet.line}
                </span>
              )}
            </div>

            {/* EXTERNAL LINK + COPY */}
            <div className="mt-3 flex items-center gap-2">
              <a
                href={`https://danskespil.dk/oddset/sports/event/${bet.event_id}`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={handleLinkClick} // <--- INTERCEPT CLICK
                className="btn btn-primary !px-3 !py-1.5 !text-xs no-underline"
              >
                Open Game ↗
              </a>

              {/* Copied Feedback */}
              {copied ? (
                <span className="animate-pulse text-xs font-medium text-emerald-400">
                  ✓ Copied "{bet.line.toString().replace('.', ',')}"
                </span>
              ) : (
                <span className="text-[10px] text-slate-500">
                  (Clicking copies line to clipboard)
                </span>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-800 hover:text-slate-100"
          >
            ✕
          </button>
        </div>

        {/* HIGH EV WARNING */}
        {isHighEv && (
          <div className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300">
            <strong>⚠️ Danger: High EV Detected ({bet.ev}%)</strong>
            <p className="mt-1 text-xs">Possible pricing error. Proceed with caution.</p>
          </div>
        )}

        {/* STATS GRID */}
        <div className="mb-6 grid grid-cols-2 gap-4 rounded-lg border border-slate-700/70 bg-slate-800/50 p-4">
          <div>
            <p className="text-xs uppercase tracking-wider text-slate-500">Odds</p>
            <p className="font-mono text-lg font-bold text-slate-100">
              {bet.danske_odds.toFixed(2)}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wider text-slate-500">Value (EV)</p>
            <p
              className={`font-mono text-lg font-bold ${
                isHighEv ? "text-rose-400" : "text-emerald-400"
              }`}
            >
              {bet.ev > 0 ? "+" : ""}
              {bet.ev}%
            </p>
          </div>
        </div>

        {/* CALCULATOR SECTION */}
        <div className="mb-6">
          <div className="mb-2 flex items-center justify-between">
            <label className="text-sm font-medium text-slate-200">Staking Strategy</label>
            <span className="text-xs font-semibold text-emerald-400">
              {(fraction * 100).toFixed(0)}% Kelly
            </span>
          </div>

          {!bankrollConfigured ? (
            <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-300">
              <strong>⚠️ No bankroll configured</strong>
              <p className="mt-1 text-xs">
                Set your starting balance in{" "}
                <a href="/settings" className="underline hover:text-amber-200">
                  Settings
                </a>{" "}
                to use Kelly staking.
              </p>
            </div>
          ) : (
            <>
              <input
                type="range"
                min="0.1"
                max="1"
                step="0.1"
                value={fraction}
                onChange={(e) => setFraction(parseFloat(e.target.value))}
                className="mb-4 w-full cursor-pointer accent-emerald-500"
              />

              <label className="mb-1 block text-sm font-medium text-slate-200">
                Stake Amount (DKK)
              </label>
              <div className="relative">
                <span className="absolute left-3 top-2.5 text-slate-500">kr</span>
                <input
                  type="number"
                  value={stake}
                  onChange={(e) => setStake(e.target.value)}
                  className="input w-full pl-8 pr-4 font-mono"
                />
              </div>
              <div className="mt-2 flex justify-between text-xs text-slate-500">
                <p>Raw Kelly: {rawStake.toFixed(2)}</p>
                <p className="font-medium text-slate-300">Rounded: {suggestedStake}</p>
              </div>
            </>
          )}
        </div>

        {/* ACTIONS */}
        <div className="flex gap-3">
          <button onClick={onClose} className="btn btn-ghost flex-1">
            Cancel
          </button>
          <button
            onClick={() => isStakeValid && onConfirm(parseFloat(stake))}
            disabled={!isStakeValid} // Disable HTML button
            className="btn btn-primary flex-1"
          >
            Place Bet
          </button>
        </div>
      </div>
    </div>
  );
}