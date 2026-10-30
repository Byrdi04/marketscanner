"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { StrategyRule, DEFAULT_RULE_VALUES, normalizeRule } from "../rules";

interface GlobalConfig {
  enabled: boolean;
  ntfy_topic: string;
  cooldown_minutes: number;
  paper_bets_limit: number;
}

interface NotificationLogEntry {
  id: number;
  bet_key: string;
  danske_odds: number;
  ev_percent: number;
  notified_at: string;
}

interface BankrollTx {
  id: number;
  tx_type: "deposit" | "withdrawal";
  amount: number;
  tx_date: string;
  note: string | null;
}

interface BankrollSummary {
  current_bankroll: number;
  available_bankroll: number;
  total_deposits: number;
  total_withdrawals: number;
  net_deposits: number;
  total_pnl: number;
  pending_stakes: number;
  account_roi: number | null;
}

interface BankrollData {
  configured: boolean;
  config: {
    starting_balance: number;
    as_of_date: string;
    default_kelly_fraction: number;
  } | null;
  summary: BankrollSummary | null;
  transactions: BankrollTx[];
}

const ALL_MARKET_TYPES = ["Spread", "Total", "MoneyLine"];

function todayStr() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => i);
const TIME_OPTIONS = [
  { label: "15 min", value:  15 },
  { label: "30 min", value:  30 },
  ...HOUR_OPTIONS.map((h) => ({ label: h === 0 ? "0 min" : `${h}h`, value: h * 60 })),
  { label: "24h", value:  1440 },
  { label: "48h", value:  2880 },
];

export default function Settings() {
  // Global settings
  const [config, setConfig] = useState<GlobalConfig>({
    enabled: false,
    ntfy_topic: "",
    cooldown_minutes: 120,
    paper_bets_limit: 5000,
  });

  // Rules
  const [rules, setRules] = useState<StrategyRule[]>([
    { ...DEFAULT_RULE_VALUES, rule_number: 1 },
    { ...DEFAULT_RULE_VALUES, rule_number: 2 },
  ]);

  // Log
  const [log, setLog] = useState<NotificationLogEntry[]>([]);

  // Bankroll & Staking
  const [bankrollData, setBankrollData] = useState<BankrollData>({
    configured: false,
    config: null,
    summary: null,
    transactions: [],
  });
  const [bankrollForm, setBankrollForm] = useState({
    starting_balance: "",
    as_of_date: todayStr(),
    default_kelly_fraction: 0.5,
  });
  const [txForm, setTxForm] = useState({
    tx_type: "deposit" as "deposit" | "withdrawal",
    amount: "",
    tx_date: todayStr(),
    note: "",
  });
  const [bankrollError, setBankrollError] = useState<string | null>(null);

  // UI state
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [testStatus, setTestStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [bankrollSaveStatus, setBankrollSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  // ---- FETCH ----

  const fetchAll = async () => {
    try {
      // Fetch global config + log
      const settingsRes = await fetch("/api/notification-settings");
      const settingsJson = await settingsRes.json();

      setConfig({
        enabled: settingsJson.config.enabled === "true",
        ntfy_topic: settingsJson.config.ntfy_topic || "",
        cooldown_minutes: parseInt(settingsJson.config.cooldown_minutes || "120"),
        paper_bets_limit: parseInt(settingsJson.config.paper_bets_limit || "5000"),
      });

      setLog(settingsJson.recent_log || []);

      // Fetch rules
      const rulesRes = await fetch("/api/notification-rules");
      const rulesJson = await rulesRes.json();

      if (Array.isArray(rulesJson.rules)) {
        const parsed = rulesJson.rules
          .map((r: any) => normalizeRule(r))
          .filter(Boolean) as StrategyRule[];
        if (parsed.length) setRules(parsed);
      }

      // Fetch bankroll & staking
      const bankrollRes = await fetch("/api/bankroll");
      if (bankrollRes.ok) {
        const bk: BankrollData = await bankrollRes.json();
        setBankrollData(bk);
        if (bk.config) {
          setBankrollForm({
            starting_balance: String(bk.config.starting_balance),
            as_of_date: bk.config.as_of_date,
            default_kelly_fraction: bk.config.default_kelly_fraction,
          });
        }
      }
    } catch (err) {
      console.error("Failed to fetch settings", err);
    }
  };

  useEffect(() => {
    fetchAll();
  }, []);

  // ---- SAVE ----

  const handleSave = async () => {
    setSaveStatus("saving");
    try {
      // Save global config
      const configRes = await fetch("/api/notification-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });

      // Save rules
      const rulesRes = await fetch("/api/notification-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rules),
      });

      if (configRes.ok && rulesRes.ok) {
        setSaveStatus("saved");
        setTimeout(() => setSaveStatus("idle"), 3000);
      } else {
        setSaveStatus("error");
      }
    } catch (err) {
      setSaveStatus("error");
    }
  };

  const handleTest = async () => {
    setTestStatus("sending");
    try {
      const res = await fetch("/api/test-notification", { method: "POST" });
      if (res.ok) {
        setTestStatus("sent");
        setTimeout(() => setTestStatus("idle"), 3000);
      } else {
        const json = await res.json();
        alert(`Error: ${json.detail}`);
        setTestStatus("error");
      }
    } catch (err) {
      setTestStatus("error");
    }
  };

  // ---- BANKROLL & STAKING ----

  const handleSaveBankroll = async () => {
    const amount = parseFloat(bankrollForm.starting_balance);
    if (isNaN(amount) || amount < 0 || !bankrollForm.as_of_date) {
      setBankrollError("Enter a valid starting balance and as-of date.");
      return;
    }
    setBankrollSaveStatus("saving");
    setBankrollError(null);
    try {
      const res = await fetch("/api/bankroll", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          starting_balance: amount,
          as_of_date: bankrollForm.as_of_date,
          default_kelly_fraction: bankrollForm.default_kelly_fraction,
        }),
      });
      if (res.ok) {
        setBankrollData(await res.json());
        setBankrollSaveStatus("saved");
        setTimeout(() => setBankrollSaveStatus("idle"), 3000);
      } else {
        const err = await res.json().catch(() => ({}));
        setBankrollError(err.detail || "Failed to save bankroll");
        setBankrollSaveStatus("error");
      }
    } catch {
      setBankrollSaveStatus("error");
    }
  };

  const handleAddTransaction = async (e: React.FormEvent) => {
    e.preventDefault();
    setBankrollError(null);
    const amount = parseFloat(txForm.amount);
    if (isNaN(amount) || amount <= 0 || !txForm.tx_date) {
      setBankrollError("Enter an amount greater than 0 and a date.");
      return;
    }
    try {
      const res = await fetch("/api/bankroll/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tx_type: txForm.tx_type,
          amount,
          tx_date: txForm.tx_date,
          note: txForm.note.trim() || null,
        }),
      });
      if (res.ok) {
        setBankrollData(await res.json());
        setTxForm({ tx_type: "deposit", amount: "", tx_date: todayStr(), note: "" });
      } else {
        const err = await res.json().catch(() => ({}));
        setBankrollError(err.detail || "Failed to add transaction");
      }
    } catch {
      setBankrollError("Failed to add transaction");
    }
  };

  const handleDeleteTransaction = async (id: number) => {
    try {
      const res = await fetch(`/api/bankroll/transactions/${id}`, { method: "DELETE" });
      if (res.ok) setBankrollData(await res.json());
    } catch {
      // ignore — ledger refresh happens on next load
    }
  };

  // ---- RULE HELPERS ----

  const updateRule = (ruleNumber: number, updates: Partial<StrategyRule>) => {
    setRules((prev) =>
      prev.map((r) => (r.rule_number === ruleNumber ? { ...r, ...updates } : r))
    );
  };

  const toggleRuleMarket = (ruleNumber: number, market: string) => {
    setRules((prev) =>
      prev.map((r) => {
        if (r.rule_number !== ruleNumber) return r;
        const has = r.market_types.includes(market);
        return {
          ...r,
          market_types: has
            ? r.market_types.filter((m) => m !== market)
            : [...r.market_types, market],
        };
      })
    );
  };

  const toggleTimeFilter = (ruleNumber: number, useTime: boolean) => {
    if (useTime) {
      updateRule(ruleNumber, { min_minutes: 0, max_minutes: 60 });
    } else {
      updateRule(ruleNumber, { min_minutes: null, max_minutes: null });
    }
  };

  // ---- RENDER RULE CARD ----

  const renderRuleCard = (rule: StrategyRule) => {
    const hasTimeFilter = rule.min_minutes !== null && rule.max_minutes !== null;

    return (
      <div
        key={rule.rule_number}
        className={`border rounded-lg p-5 transition-colors ${
          rule.enabled
            ? "border-slate-600 bg-slate-900"
            : "border-slate-800 bg-slate-900/50 opacity-70"
        }`}
      >
        {/* Rule Header */}
        <div className="flex items-center justify-between mb-5">
          <h3 className="font-semibold text-slate-200">{rule.name?.trim() || `Rule ${rule.rule_number}`}</h3>
          <button
            onClick={() => updateRule(rule.rule_number, { enabled: !rule.enabled })}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              rule.enabled ? "bg-emerald-500" : "bg-slate-700"
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                rule.enabled ? "translate-x-6" : "translate-x-1"
              }`}
            />
          </button>
        </div>

        {/* Min EV */}
        <div className="mb-4">
          <label className="block text-sm font-medium text-slate-300 mb-1">
            Min EV: <span className="font-mono text-slate-100">{rule.min_ev}%</span>
          </label>
          <input
            type="range"
            min="0"
            max="10"
            step="0.5"
            value={rule.min_ev}
            onChange={(e) =>
              updateRule(rule.rule_number, { min_ev: parseFloat(e.target.value) })
            }
            className="w-full cursor-pointer accent-emerald-500"
          />
          <div className="flex justify-between text-xs text-slate-500 mt-1">
            <span>0%</span>
            <span>10%</span>
          </div>
        </div>

        {/* Max EV */}
        <div className="mb-4">
          <label className="block text-sm font-medium text-slate-300 mb-1">
            Max EV: <span className="font-mono text-slate-100">{rule.max_ev}%</span>
          </label>
          <input
            type="range"
            min="0"
            max="10"
            step="0.5"
            value={rule.max_ev}
            onChange={(e) =>
              updateRule(rule.rule_number, { max_ev: parseFloat(e.target.value) })
            }
            className="w-full cursor-pointer accent-emerald-500"
          />
          <div className="flex justify-between text-xs text-slate-500 mt-1">
            <span>0%</span>
            <span>10%</span>
          </div>
        </div>

        {/* Odds Range */}
        <div className="grid grid-cols-2 gap-3 mb-4">
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Min Odds
            </label>
            <input
              type="number"
              step="0.05"
              min="1.01"
              max="10"
              value={rule.min_odds}
              onChange={(e) =>
                updateRule(rule.rule_number, { min_odds: parseFloat(e.target.value) })
              }
              className="input font-mono"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1">
              Max Odds
            </label>
            <input
              type="number"
              step="0.05"
              min="1.01"
              max="10"
              value={rule.max_odds}
              onChange={(e) =>
                updateRule(rule.rule_number, { max_odds: parseFloat(e.target.value) })
              }
              className="input font-mono"
            />
          </div>
        </div>

        {/* Market Types */}
        <div className="mb-4">
          <label className="block text-xs font-medium text-slate-300 mb-2">
            Markets
          </label>
          <div className="flex gap-2">
            {ALL_MARKET_TYPES.map((market) => (
              <button
                key={market}
                onClick={() => toggleRuleMarket(rule.rule_number, market)}
                className={`px-2.5 py-1 rounded text-xs font-medium border transition-colors ${
                  rule.market_types.includes(market)
                    ? "bg-emerald-500 text-slate-950 border-emerald-500"
                    : "bg-slate-800/60 text-slate-300 border-slate-700 hover:border-emerald-500/60"
                }`}
              >
                {market}
              </button>
            ))}
          </div>
        </div>

        {/* Time Window */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="block text-xs font-medium text-slate-300">
              Time Before Tip-Off
            </label>
            <button
              onClick={() => toggleTimeFilter(rule.rule_number, !hasTimeFilter)}
              className={`text-xs px-2 py-0.5 rounded border transition-colors ${
                hasTimeFilter
                  ? "bg-emerald-500 text-slate-950 border-emerald-500"
                  : "bg-slate-800/60 text-slate-300 border-slate-700 hover:border-emerald-500/60"
              }`}
            >
              {hasTimeFilter ? "Active" : "Off"}
            </button>
          </div>

          {hasTimeFilter && (
            <div className="flex items-center gap-2 mt-2">
              <select
                value={rule.min_minutes ?? 0}
                onChange={(e) =>
                  updateRule(rule.rule_number, {
                    min_minutes: parseInt(e.target.value),
                  })
                }
                className="input !px-2 !py-1.5 !text-sm"
              >
                {TIME_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <span className="text-sm text-slate-400">to</span>
              <select
                value={rule.max_minutes ?? 60}
                onChange={(e) =>
                  updateRule(rule.rule_number, {
                    max_minutes: parseInt(e.target.value),
                  })
                }
                className="input !px-2 !py-1.5 !text-sm"
              >
                {TIME_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <span className="text-sm text-slate-400">before tip-off</span>
            </div>
          )}

          {!hasTimeFilter && (
            <p className="text-xs text-slate-500">
              No time filter — all games qualify regardless of start time
            </p>
          )}
        </div>
      </div>
    );
  };

  // ---- PAGE ----

  return (
    <main className="min-h-screen bg-slate-950 font-sans text-slate-100">
      <div className="mx-auto max-w-3xl px-4 py-6 md:px-6 lg:py-8">
        {/* HEADER */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight text-slate-50 sm:text-3xl">
            Settings
          </h1>
          <div className="mt-2 flex gap-4 text-sm">
            <Link href="/" className="font-medium text-emerald-400 hover:text-emerald-300 hover:underline">
              ← Back to Scanner
            </Link>
          </div>
        </div>

        {/* GLOBAL SETTINGS CARD */}
        <div className="card p-6 mb-6">
          <h2 className="text-lg font-semibold mb-1">Push Notifications</h2>
          <p className="text-sm text-slate-400 mb-6">
            Delivered via{" "}
            <a
              href="https://ntfy.sh"
              target="_blank"
              rel="noopener noreferrer"
              className="text-emerald-400 hover:text-emerald-300 hover:underline"
            >
              ntfy.sh
            </a>
            . Install the app on your phone and subscribe to your topic.
          </p>

          <div className="space-y-6">
            {/* ENABLE TOGGLE */}
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-slate-200">Enable Notifications</p>
                <p className="text-xs text-slate-500 mt-0.5">
                  Master switch — alerts fire on each scheduled scan
                </p>
              </div>
              <button
                onClick={() => setConfig((prev) => ({ ...prev, enabled: !prev.enabled }))}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  config.enabled ? "bg-emerald-500" : "bg-slate-700"
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    config.enabled ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </button>
            </div>

            {/* NTFY TOPIC */}
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1">
                Ntfy Topic
              </label>
              <input
                type="text"
                value={config.ntfy_topic}
                onChange={(e) =>
                  setConfig((prev) => ({ ...prev, ntfy_topic: e.target.value }))
                }
                placeholder="e.g. nba-scanner-abc123"
                className="input"
              />
              <p className="text-xs text-slate-500 mt-1">
                Must match the topic you subscribed to in the Ntfy app
              </p>
            </div>

            {/* COOLDOWN */}
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1">
                Cooldown:{" "}
                <span className="font-mono text-slate-100">
                  {config.cooldown_minutes} min
                </span>
              </label>
              <input
                type="range"
                min="30"
                max="240"
                step="30"
                value={config.cooldown_minutes}
                onChange={(e) =>
                  setConfig((prev) => ({
                    ...prev,
                    cooldown_minutes: parseInt(e.target.value),
                  }))
                }
                className="w-full cursor-pointer accent-emerald-500"
              />
              <div className="flex justify-between text-xs text-slate-500 mt-1">
                <span>30m</span>
                <span>4h</span>
              </div>
              <p className="text-xs text-slate-500 mt-1">
                Minimum time between repeat alerts for the same unchanged bet
              </p>
            </div>
          </div>

          {/* ACTION BUTTONS */}
          <div className="flex gap-3 mt-8">
            <button
              onClick={handleSave}
              disabled={saveStatus === "saving"}
              className="btn btn-primary"
            >
              {saveStatus === "saving" && "Saving..."}
              {saveStatus === "saved" && "Saved!"}
              {saveStatus === "error" && "Error - Try Again"}
              {saveStatus === "idle" && "Save Settings"}
            </button>

            <button
              onClick={handleTest}
              disabled={testStatus === "sending"}
              className="btn btn-ghost"
            >
              {testStatus === "sending" && "Sending..."}
              {testStatus === "sent" && "Sent! Check your phone"}
              {testStatus === "error" && "Error - Try Again"}
              {testStatus === "idle" && "Send Test Notification"}
            </button>
          </div>
        </div>

        {/* BANKROLL & STAKING CARD */}
        <div className="card p-6 mb-6">
          <h2 className="text-lg font-semibold mb-1">Bankroll & Staking</h2>
          <p className="text-sm text-slate-400 mb-6">
            The bankroll is derived automatically: starting balance + deposits − withdrawals + PnL from settled
            bets. Bets placed <strong>before the as-of date</strong> are treated as history and never touch these numbers.
          </p>

          <div className="space-y-6">
            {/* STARTING BALANCE + AS-OF DATE */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">
                  Starting Balance (kr)
                </label>
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={bankrollForm.starting_balance}
                  onChange={(e) =>
                    setBankrollForm((prev) => ({ ...prev, starting_balance: e.target.value }))
                  }
                  placeholder="e.g. 10000"
                  className="input font-mono"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">
                  As-Of Date
                </label>
                <input
                  type="date"
                  value={bankrollForm.as_of_date}
                  onChange={(e) =>
                    setBankrollForm((prev) => ({ ...prev, as_of_date: e.target.value }))
                  }
                  className="input"
                />
                <p className="text-xs text-slate-500 mt-1">
                  Your balance on this date. Deposits/withdrawals dated earlier are rejected.
                </p>
              </div>
            </div>

            {/* DEFAULT KELLY FRACTION */}
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1">
                Default Kelly Fraction:{" "}
                <span className="font-mono text-emerald-400">
                  {(bankrollForm.default_kelly_fraction * 100).toFixed(0)}%
                </span>
              </label>
              <input
                type="range"
                min="0.05"
                max="1"
                step="0.05"
                value={bankrollForm.default_kelly_fraction}
                onChange={(e) =>
                  setBankrollForm((prev) => ({
                    ...prev,
                    default_kelly_fraction: parseFloat(e.target.value),
                  }))
                }
                className="w-full cursor-pointer accent-emerald-500"
              />
              <div className="flex justify-between text-xs text-slate-500 mt-1">
                <span>5%</span>
                <span>100%</span>
              </div>
              <p className="text-xs text-slate-500 mt-1">
                Starting point for the Kelly slider in the bet modal — you can still adjust each bet.
              </p>
            </div>

            {/* COMPUTED READOUT */}
            {bankrollData.summary && (
              <div className="grid grid-cols-2 gap-3 rounded-lg border border-slate-700/70 bg-slate-800/50 p-4 sm:grid-cols-4">
                <div>
                  <p className="text-xs uppercase tracking-wider text-slate-500">Current</p>
                  <p className="mt-0.5 font-mono text-lg font-bold text-slate-100">
                    kr {bankrollData.summary.current_bankroll.toLocaleString("da-DK", { maximumFractionDigits: 0 })}
                  </p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wider text-slate-500">Available</p>
                  <p className="mt-0.5 font-mono text-lg font-bold text-slate-100">
                    kr {bankrollData.summary.available_bankroll.toLocaleString("da-DK", { maximumFractionDigits: 0 })}
                  </p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wider text-slate-500">Net PnL</p>
                  <p
                    className={`mt-0.5 font-mono text-lg font-bold ${
                      bankrollData.summary.total_pnl >= 0 ? "text-emerald-400" : "text-rose-400"
                    }`}
                  >
                    {bankrollData.summary.total_pnl >= 0 ? "+" : ""}
                    {bankrollData.summary.total_pnl.toLocaleString("da-DK", { maximumFractionDigits: 0 })}
                  </p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wider text-slate-500">Account ROI</p>
                  <p className="mt-0.5 font-mono text-lg font-bold text-slate-100">
                    {bankrollData.summary.account_roi === null
                      ? "—"
                      : `${bankrollData.summary.account_roi.toLocaleString("da-DK", { maximumFractionDigits: 1 })}%`}
                  </p>
                </div>
              </div>
            )}

            {bankrollData.summary && bankrollData.summary.pending_stakes > 0 && (
              <p className="text-xs text-slate-500">
                Pending stakes: kr{" "}
                {bankrollData.summary.pending_stakes.toLocaleString("da-DK", { maximumFractionDigits: 0 })} — deducted
                from Available until they settle.
              </p>
            )}

            {/* SAVE */}
            <div className="flex items-center gap-3">
              <button
                onClick={handleSaveBankroll}
                disabled={bankrollSaveStatus === "saving"}
                className="btn btn-primary"
              >
                {bankrollSaveStatus === "saving" && "Saving..."}
                {bankrollSaveStatus === "saved" && "Saved!"}
                {bankrollSaveStatus === "error" && "Error - Try Again"}
                {bankrollSaveStatus === "idle" && "Save Bankroll"}
              </button>
              {bankrollError && <span className="text-sm text-rose-400">{bankrollError}</span>}
            </div>
          </div>

          {/* DEPOSITS & WITHDRAWALS LEDGER */}
          <div className="mt-8">
            <h3 className="text-sm font-semibold text-slate-200 mb-1">Deposits & Withdrawals</h3>
            <p className="text-xs text-slate-500 mb-4">
              Each row moves the bankroll and feeds Account ROI. Transactions dated before the as-of date are rejected.
            </p>

            {!bankrollData.configured ? (
              <p className="text-sm text-slate-500">
                Save a starting balance and as-of date first to enable the ledger.
              </p>
            ) : (
              <>
                {/* ADD FORM */}
                <form onSubmit={handleAddTransaction} className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">Type</label>
                    <div className="flex overflow-hidden rounded-lg border border-slate-700">
                      {(["deposit", "withdrawal"] as const).map((t) => (
                        <button
                          key={t}
                          type="button"
                          onClick={() => setTxForm((prev) => ({ ...prev, tx_type: t }))}
                          className={`flex-1 px-2 py-1.5 text-xs font-medium capitalize transition-colors ${
                            txForm.tx_type === t
                              ? t === "deposit"
                                ? "bg-emerald-500 text-slate-950"
                                : "bg-rose-500 text-slate-950"
                              : "bg-slate-800/60 text-slate-300"
                          }`}
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">Amount (kr)</label>
                    <input
                      type="number"
                      min="0.01"
                      step="any"
                      value={txForm.amount}
                      onChange={(e) => setTxForm((prev) => ({ ...prev, amount: e.target.value }))}
                      placeholder="500"
                      className="input !py-1.5 !text-sm font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">Date</label>
                    <input
                      type="date"
                      value={txForm.tx_date}
                      onChange={(e) => setTxForm((prev) => ({ ...prev, tx_date: e.target.value }))}
                      className="input !py-1.5 !text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">Note (optional)</label>
                    <input
                      type="text"
                      value={txForm.note}
                      onChange={(e) => setTxForm((prev) => ({ ...prev, note: e.target.value }))}
                      placeholder="Top up"
                      className="input !py-1.5 !text-sm"
                    />
                  </div>
                  <div className="flex items-end">
                    <button type="submit" className="btn btn-ghost w-full !py-1.5 !text-sm">
                      Add
                    </button>
                  </div>
                </form>

                {/* LEDGER TABLE */}
                {bankrollData.transactions.length === 0 ? (
                  <p className="py-6 text-center text-sm text-slate-500">
                    No deposits or withdrawals yet.
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="data-table text-sm">
                      <thead className="border-b border-slate-700/80 bg-slate-900/80 font-medium text-slate-400">
                        <tr>
                          <th className="px-4 py-2">Date</th>
                          <th className="px-4 py-2">Type</th>
                          <th className="px-4 py-2 text-right">Amount</th>
                          <th className="px-4 py-2">Note</th>
                          <th className="px-4 py-2" />
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800">
                        {bankrollData.transactions.map((tx) => (
                          <tr key={tx.id}>
                            <td className="whitespace-nowrap px-4 py-3 text-slate-400">{tx.tx_date}</td>
                            <td className="px-4 py-3">
                              <span
                                className={`inline-block rounded-full px-2 py-0.5 text-xs font-bold ${
                                  tx.tx_type === "deposit"
                                    ? "bg-emerald-500/10 text-emerald-300"
                                    : "bg-rose-500/10 text-rose-300"
                                }`}
                              >
                                {tx.tx_type}
                              </span>
                            </td>
                            <td
                              className={`px-4 py-3 text-right font-mono ${
                                tx.tx_type === "deposit" ? "text-emerald-300" : "text-rose-300"
                              }`}
                            >
                              {tx.tx_type === "deposit" ? "+" : "−"}
                              {tx.amount.toFixed(2)}
                            </td>
                            <td className="px-4 py-3 text-slate-400">{tx.note || "—"}</td>
                            <td className="px-4 py-3 text-right">
                              <button
                                onClick={() => handleDeleteTransaction(tx.id)}
                                aria-label="Delete transaction"
                                className="rounded p-1 text-slate-500 transition hover:bg-slate-800 hover:text-rose-400"
                              >
                                ✕
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* PAPER TRADING SETTINGS CARD */}
        <div className="card p-6 mb-6">
          <h2 className="text-lg font-semibold mb-1">Paper Trading</h2>
          <p className="text-sm text-slate-400 mb-6">
            Configure how many historical paper bets are loaded for analysis.
            Higher numbers give better data but use more memory.
          </p>

          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1">
              Bet History Limit:{" "}
              <span className="font-mono text-slate-100">
                {config.paper_bets_limit.toLocaleString()}
              </span>
            </label>
            <input
              type="range"
              min="500"
              max="50000"
              step="500"
              value={config.paper_bets_limit}
              onChange={(e) =>
                setConfig((prev) => ({
                  ...prev,
                  paper_bets_limit: parseInt(e.target.value),
                }))
              }
              className="w-full cursor-pointer accent-emerald-500"
            />
            <div className="flex justify-between text-xs text-slate-500 mt-1">
              <span>500</span>
              <span>50,000</span>
            </div>
            <p className="text-xs text-slate-500 mt-1">
              Default: 5,000 bets. Higher values will load more data into the browser.
            </p>
          </div>
        </div>

        {/* RULES CARDS */}
        <div className="mb-6">
          <h2 className="text-lg font-semibold mb-1">Notification Rules</h2>
          <p className="text-sm text-slate-400 mb-4">
            A bet triggers a notification if it matches <strong>either</strong> rule.
            Each rule has its own filters.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {rules.map((rule) => renderRuleCard(rule))}
          </div>
        </div>

        {/* NOTIFICATION LOG CARD */}
        <div className="card overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-800">
            <h2 className="text-lg font-semibold">Recent Notifications</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Last 20 alerts sent by the scanner
            </p>
          </div>

          {log.length === 0 ? (
            <div className="px-6 py-10 text-center text-sm text-slate-500">
              No notifications sent yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table text-sm">
                <thead className="border-b border-slate-700/80 bg-slate-900/80 font-medium text-slate-400">
                  <tr>
                    <th className="px-6 py-3">Sent At</th>
                    <th className="px-6 py-3">Bet</th>
                    <th className="px-6 py-3 text-right">Odds</th>
                    <th className="px-6 py-3 text-right">EV</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {log.map((entry) => (
                    <tr key={entry.id} className="transition-colors hover:bg-slate-800/40">
                      <td data-label="Sent" className="whitespace-nowrap px-6 py-4 text-xs text-slate-500">
                        {new Date(entry.notified_at).toLocaleString(undefined, {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </td>
                      <td data-label="Bet" className="break-all px-6 py-4 font-mono text-xs text-slate-300">
                        {entry.bet_key}
                      </td>
                      <td data-label="Odds" className="px-6 py-4 text-right font-mono">
                        {entry.danske_odds.toFixed(2)}
                      </td>
                      <td data-label="EV" className="px-6 py-4 text-right font-mono font-medium text-emerald-400">
                        +{entry.ev_percent.toFixed(1)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}