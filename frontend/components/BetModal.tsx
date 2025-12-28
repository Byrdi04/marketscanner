"use client";

import { useState, useEffect } from "react";

interface BetModalProps {
  bet: any;
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (stake: number) => void;
  currentBankroll: number;
}

// YOUR CUSTOM ROUNDING LOGIC (DKK)
const getSmartRoundedStake = (rawStake: number) => {
  if (rawStake <= 0) return 0;
  if (rawStake < 20) return Math.round(rawStake / 5) * 5; 
  if (rawStake < 100) return Math.round(rawStake / 10) * 10;
  if (rawStake < 500) return Math.round(rawStake / 25) * 25;
  return Math.round(rawStake / 50) * 50;
};

export default function BetModal({ bet, isOpen, onClose, onConfirm, currentBankroll }: BetModalProps) {
  const [stake, setStake] = useState<string>("");
  const [fraction, setFraction] = useState<number>(0.5); 
  const [copied, setCopied] = useState(false); // State for clipboard feedback

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
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6">
        
        {/* HEADER */}
        <div className="flex justify-between items-start mb-4">
          <div className="flex-1">
            {/* MATCH INFO */}
            <p className="text-xs text-gray-400 uppercase font-semibold mb-1">{bet.match}</p>
            
            {/* SELECTION + LINE BADGE */}
            <div className="flex items-center flex-wrap gap-2">
              <h2 className="text-2xl font-bold text-gray-900">{bet.selection}</h2>
              
              {/* NEW: VISUAL BADGE FOR LINE */}
              {bet.line && (
                <span className="bg-gray-100 border border-gray-300 text-gray-800 text-sm font-mono px-2 py-0.5 rounded">
                   {bet.type}: {bet.line}
                </span>
              )}
            </div>

            {/* EXTERNAL LINK + COPY */}
            <div className="flex items-center gap-2 mt-2">
              <a 
                href={`https://danskespil.dk/oddset/sports/event/${bet.event_id}`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={handleLinkClick} // <--- INTERCEPT CLICK
                className="text-xs bg-blue-600 text-white px-3 py-1.5 rounded hover:bg-blue-700 transition flex items-center gap-1 font-medium no-underline"
              >
                Open Game ↗
              </a>
              
              {/* Copied Feedback */}
              {copied ? (
                <span className="text-xs text-green-600 font-medium animate-pulse">
                  ✓ Copied "{bet.line.toString().replace('.', ',')}"
                </span>
              ) : (
                <span className="text-[10px] text-gray-400">
                  (Clicking copies line to clipboard)
                </span>
              )}
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1">✕</button>
        </div>

        {/* HIGH EV WARNING */}
        {isHighEv && (
          <div className="mb-4 bg-red-50 border border-red-200 p-3 rounded-md text-sm text-red-700">
            <strong>⚠️ Danger: High EV Detected ({bet.ev}%)</strong>
            <p className="mt-1 text-xs">
              Possible pricing error. Proceed with caution.
            </p>
          </div>
        )}

        {/* STATS GRID */}
        <div className="grid grid-cols-2 gap-4 mb-6 bg-gray-50 p-4 rounded-md border border-gray-100">
          <div>
            <p className="text-xs text-gray-500 uppercase">Odds</p>
            <p className="text-lg font-mono font-bold text-gray-900">{bet.danske_odds.toFixed(2)}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500 uppercase">Value (EV)</p>
            <p className={`text-lg font-mono font-bold ${isHighEv ? "text-red-600" : "text-green-600"}`}>
              {bet.ev > 0 ? "+" : ""}{bet.ev}%
            </p>
          </div>
        </div>

        {/* CALCULATOR SECTION */}
        <div className="mb-6">
          <div className="flex justify-between items-center mb-2">
            <label className="text-sm font-medium text-gray-700">Staking Strategy</label>
            <span className="text-xs text-blue-600 font-medium">
              {(fraction * 100).toFixed(0)}% Kelly
            </span>
          </div>
          
          <input 
            type="range" 
            min="0.1" max="1" step="0.1" 
            value={fraction}
            onChange={(e) => setFraction(parseFloat(e.target.value))}
            className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-black mb-4"
          />

          <label className="block text-sm font-medium text-gray-700 mb-1">
            Stake Amount (DKK)
          </label>
          <div className="relative">
            <span className="absolute left-3 top-2 text-gray-500">kr</span>
            <input
              type="number"
              value={stake}
              onChange={(e) => setStake(e.target.value)}
              className="w-full pl-8 pr-4 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-black focus:border-transparent outline-none font-mono"
            />
          </div>
          <div className="flex justify-between mt-2 text-xs text-gray-500">
            <p>Raw Kelly: {rawStake.toFixed(2)}</p>
            <p className="font-medium text-black">Rounded: {suggestedStake}</p>
          </div>
        </div>

        {/* ACTIONS */}
        <div className="flex gap-3">
          <button 
            onClick={onClose}
            className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50 transition"
          >
            Cancel
          </button>
          <button 
            onClick={() => isStakeValid && onConfirm(parseFloat(stake))}
            disabled={!isStakeValid} // Disable HTML button
            className={`flex-1 px-4 py-2 rounded-md transition font-medium text-white
              ${isStakeValid 
                ? "bg-black hover:bg-gray-800" // Active Style
                : "bg-gray-300 cursor-not-allowed" // Disabled Style
              }
            `}
          >
            Place Bet
          </button>
        </div>

      </div>
    </div>
  );
}