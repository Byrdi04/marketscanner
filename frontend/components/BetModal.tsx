"use client";

import { useState, useEffect } from "react";

interface BetModalProps {
  bet: any;
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (stake: number) => void;
  currentBankroll: number;
}

// HELPER: Round to "Human" numbers to avoid bot detection
const getSmartRoundedStake = (rawStake: number) => {
  if (rawStake <= 0) return 0;
  if (rawStake < 20) return Math.round(rawStake / 5) * 5; // Keep small bets precise-ish ($12)
  if (rawStake < 100) return Math.round(rawStake / 10) * 10; // Round to nearest 10 ($43 -> $45)
  if (rawStake < 500) return Math.round(rawStake / 25) * 25; // Round to nearest 10 ($143 -> $140)
  return Math.round(rawStake / 50) * 50; // Big bets round to $50 ($530 -> $550)
};

export default function BetModal({ bet, isOpen, onClose, onConfirm, currentBankroll }: BetModalProps) {
  const [stake, setStake] = useState<string>("");
  const [fraction, setFraction] = useState<number>(0.5); 

  // SAFE CALCULATIONS
  const b = bet ? bet.danske_odds - 1 : 0;
  const evDecimal = bet ? bet.ev / 100 : 0;
  const fullKellyPercent = b > 0 ? evDecimal / b : 0;
  
  const adjustedKellyPercent = fullKellyPercent * fraction;
  const rawStake = currentBankroll * adjustedKellyPercent;
  const suggestedStake = getSmartRoundedStake(rawStake);

  const isHighEv = bet && bet.ev > 15; // Flag bets with >15% EV as suspicious

  useEffect(() => {
    if (isOpen && bet && suggestedStake > 0) {
      setStake(suggestedStake.toString());
    }
  }, [bet, fraction, currentBankroll, isOpen, suggestedStake]);

  if (!isOpen || !bet) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6">
        
        {/* HEADER */}
        <div className="flex justify-between items-start mb-4">
          <div>
            <h2 className="text-xl font-bold text-gray-900">{bet.selection}</h2>
            <div className="flex items-center gap-2 mt-1">
              <a 
                href={`https://danskespil.dk/oddset/sports/event/${bet.event_id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs bg-gray-100 text-gray-700 px-2 py-0.5 rounded hover:bg-gray-200 transition"
              >
                Open Game ↗
              </a>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">✕</button>
        </div>

        {/* HIGH EV WARNING (Palpable Error Check) */}
        {isHighEv && (
          <div className="mb-4 bg-red-50 border border-red-200 p-3 rounded-md text-sm text-red-700">
            <strong>⚠️ Danger: High EV Detected ({bet.ev}%)</strong>
            <p className="mt-1 text-xs">
              This might be a "Palpable Error" (pricing mistake). 
              Bookmakers often void these bets and flag accounts that take them.
              Proceed with extreme caution.
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
              +{bet.ev}%
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
            Stake Amount ($)
          </label>
          <div className="relative">
            <span className="absolute left-3 top-2 text-gray-500">$</span>
            <input
              type="number"
              value={stake}
              onChange={(e) => setStake(e.target.value)}
              className="w-full pl-8 pr-4 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-black focus:border-transparent outline-none font-mono"
            />
          </div>
          <div className="flex justify-between mt-2 text-xs text-gray-500">
            <p>Raw Kelly: ${rawStake.toFixed(2)}</p>
            <p className="font-medium text-black">Rounded: ${suggestedStake}</p>
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
            onClick={() => onConfirm(parseFloat(stake))}
            className="flex-1 px-4 py-2 bg-black text-white rounded-md hover:bg-gray-800 transition font-medium"
          >
            Place Bet
          </button>
        </div>

      </div>
    </div>
  );
}