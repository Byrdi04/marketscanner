"use client";

import { useState, useEffect } from "react";

interface BetModalProps {
  bet: any; 
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (stake: number) => void;
  currentBankroll: number;
}

export default function BetModal({ bet, isOpen, onClose, onConfirm, currentBankroll }: BetModalProps) {
  // 1. HOOKS ALWAYS COME FIRST (Before any return statements)
  const [stake, setStake] = useState<string>("");
  const [fraction, setFraction] = useState<number>(0.5); 

  // 2. SAFE CALCULATIONS
  // We use ternary operators (? :) to ensure this math runs without crashing 
  // even if 'bet' is temporarily null (before the component decides not to render).
  const b = bet ? bet.danske_odds - 1 : 0;
  const evDecimal = bet ? bet.ev / 100 : 0;
  
  // Avoid division by zero
  const fullKellyPercent = b > 0 ? evDecimal / b : 0;
  
  const adjustedKellyPercent = fullKellyPercent * fraction;
  const suggestedStake = Math.round(currentBankroll * adjustedKellyPercent);

  // 3. EFFECT (Now it's safe because it's not behind a return)
  useEffect(() => {
    if (isOpen && bet && suggestedStake > 0) {
      setStake(suggestedStake.toString());
    }
  }, [bet, fraction, currentBankroll, isOpen, suggestedStake]);

  // 4. CONDITIONAL RETURN (The Gatekeeper)
  // Now we can safely decide not to render anything
  if (!isOpen || !bet) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl max-w-md w-full p-6">
        
        {/* HEADER */}
        <div className="flex justify-between items-start mb-4">
          <div>
            <h2 className="text-xl font-bold text-gray-900">{bet.selection}</h2>
            <p className="text-sm text-gray-500">{bet.match}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">✕</button>
        </div>

        {/* STATS GRID */}
        <div className="grid grid-cols-2 gap-4 mb-6 bg-gray-50 p-4 rounded-md border border-gray-100">
          <div>
            <p className="text-xs text-gray-500 uppercase">Odds</p>
            <p className="text-lg font-mono font-bold text-gray-900">{bet.danske_odds.toFixed(2)}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500 uppercase">Value (EV)</p>
            <p className="text-lg font-mono font-bold text-green-600">+{bet.ev}%</p>
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
          
          {/* Slider for Kelly Fraction */}
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
          <p className="text-xs text-gray-500 mt-2">
            Suggestion: <span className="font-bold">${suggestedStake}</span> based on bankroll of ${currentBankroll}
          </p>
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