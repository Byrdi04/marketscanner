"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

interface GlobalConfig {
  enabled: boolean;
  ntfy_topic: string;
  cooldown_minutes: number;
  paper_bets_limit: number;
}

interface NotificationRule {
  rule_number: number;
  enabled: boolean;
  min_ev: number;
  min_odds: number;
  max_odds: number;
  market_types: string[];
  min_minutes: number | null;
  max_minutes: number | null;
}

interface NotificationLogEntry {
  id: number;
  bet_key: string;
  danske_odds: number;
  ev_percent: number;
  notified_at: string;
}

const ALL_MARKET_TYPES = ["Spread", "Total", "MoneyLine"];

const TIME_OPTIONS = [
  { label: "15 min", value: 15 },
  { label: "30 min", value: 30 },
  { label: "1h", value: 60 },
  { label: "2h", value: 120 },
  { label: "3h", value: 180 },
  { label: "6h", value: 360 },
  { label: "12h", value: 720 },
  { label: "24h", value: 1440 },
  { label: "48h", value: 2880 },
];

const DEFAULT_RULE: NotificationRule = {
  rule_number: 1,
  enabled: false,
  min_ev: 3.5,
  min_odds: 1.60,
  max_odds: 2.50,
  market_types: ["Spread", "Total", "MoneyLine"],
  min_minutes: null,
  max_minutes: null,
};

export default function Settings() {
  // Global settings
  const [config, setConfig] = useState<GlobalConfig>({
    enabled: false,
    ntfy_topic: "",
    cooldown_minutes: 120,
    paper_bets_limit: 5000,
  });

  // Rules
  const [rules, setRules] = useState<NotificationRule[]>([
    { ...DEFAULT_RULE, rule_number: 1 },
    { ...DEFAULT_RULE, rule_number: 2 },
  ]);

  // Log
  const [log, setLog] = useState<NotificationLogEntry[]>([]);

  // UI state
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [testStatus, setTestStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");

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

      if (rulesJson.rules && rulesJson.rules.length === 2) {
        setRules(
          rulesJson.rules.map((r: any) => ({
            rule_number: r.rule_number,
            enabled: r.enabled === "true" || r.enabled === true,
            min_ev: parseFloat(r.min_ev),
            min_odds: parseFloat(r.min_odds),
            max_odds: parseFloat(r.max_odds),
            market_types: Array.isArray(r.market_types) ? r.market_types : [],
            min_minutes: r.min_minutes,
            max_minutes: r.max_minutes,
          }))
        );
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

  // ---- RULE HELPERS ----

  const updateRule = (ruleNumber: number, updates: Partial<NotificationRule>) => {
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

  const renderRuleCard = (rule: NotificationRule) => {
    const hasTimeFilter = rule.min_minutes !== null && rule.max_minutes !== null;

    return (
      <div
        key={rule.rule_number}
        className={`border rounded-lg p-5 transition-colors ${
          rule.enabled
            ? "border-gray-300 bg-white"
            : "border-gray-200 bg-gray-50 opacity-70"
        }`}
      >
        {/* Rule Header */}
        <div className="flex items-center justify-between mb-5">
          <h3 className="font-semibold text-gray-800">Rule {rule.rule_number}</h3>
          <button
            onClick={() => updateRule(rule.rule_number, { enabled: !rule.enabled })}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              rule.enabled ? "bg-gray-900" : "bg-gray-300"
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
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Min EV: <span className="font-mono text-gray-900">{rule.min_ev}%</span>
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
            className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-black"
          />
          <div className="flex justify-between text-xs text-gray-400 mt-1">
            <span>0%</span>
            <span>10%</span>
          </div>
        </div>

        {/* Odds Range */}
        <div className="grid grid-cols-2 gap-3 mb-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
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
              className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-gray-900"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
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
              className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-gray-900"
            />
          </div>
        </div>

        {/* Market Types */}
        <div className="mb-4">
          <label className="block text-xs font-medium text-gray-700 mb-2">
            Markets
          </label>
          <div className="flex gap-2">
            {ALL_MARKET_TYPES.map((market) => (
              <button
                key={market}
                onClick={() => toggleRuleMarket(rule.rule_number, market)}
                className={`px-2.5 py-1 rounded text-xs font-medium border transition-colors ${
                  rule.market_types.includes(market)
                    ? "bg-gray-900 text-white border-gray-900"
                    : "bg-white text-gray-600 border-gray-300 hover:border-gray-500"
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
            <label className="block text-xs font-medium text-gray-700">
              Time Before Tip-Off
            </label>
            <button
              onClick={() => toggleTimeFilter(rule.rule_number, !hasTimeFilter)}
              className={`text-xs px-2 py-0.5 rounded border transition-colors ${
                hasTimeFilter
                  ? "bg-gray-900 text-white border-gray-900"
                  : "bg-white text-gray-500 border-gray-300 hover:border-gray-500"
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
                className="border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
              >
                {TIME_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <span className="text-sm text-gray-500">to</span>
              <select
                value={rule.max_minutes ?? 60}
                onChange={(e) =>
                  updateRule(rule.rule_number, {
                    max_minutes: parseInt(e.target.value),
                  })
                }
                className="border border-gray-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
              >
                {TIME_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <span className="text-sm text-gray-500">before tip-off</span>
            </div>
          )}

          {!hasTimeFilter && (
            <p className="text-xs text-gray-400">
              No time filter — all games qualify regardless of start time
            </p>
          )}
        </div>
      </div>
    );
  };

  // ---- PAGE ----

  return (
    <main className="min-h-screen bg-gray-50 p-8 font-sans text-gray-900">
      <div className="max-w-3xl mx-auto">
        {/* HEADER */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
          <div className="flex gap-4 mt-1 text-sm">
            <Link href="/" className="text-blue-600 hover:underline">
              ← Back to Scanner
            </Link>
          </div>
        </div>

        {/* GLOBAL SETTINGS CARD */}
        <div className="bg-white shadow-sm rounded-lg border border-gray-200 p-6 mb-6">
          <h2 className="text-lg font-semibold mb-1">Push Notifications</h2>
          <p className="text-sm text-gray-500 mb-6">
            Delivered via{" "}
            <a
              href="https://ntfy.sh"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline"
            >
              ntfy.sh
            </a>
            . Install the app on your phone and subscribe to your topic.
          </p>

          <div className="space-y-6">
            {/* ENABLE TOGGLE */}
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-gray-800">Enable Notifications</p>
                <p className="text-xs text-gray-400 mt-0.5">
                  Master switch — alerts fire on each scheduled scan
                </p>
              </div>
              <button
                onClick={() => setConfig((prev) => ({ ...prev, enabled: !prev.enabled }))}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  config.enabled ? "bg-gray-900" : "bg-gray-300"
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
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Ntfy Topic
              </label>
              <input
                type="text"
                value={config.ntfy_topic}
                onChange={(e) =>
                  setConfig((prev) => ({ ...prev, ntfy_topic: e.target.value }))
                }
                placeholder="e.g. nba-scanner-abc123"
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
              />
              <p className="text-xs text-gray-400 mt-1">
                Must match the topic you subscribed to in the Ntfy app
              </p>
            </div>

            {/* COOLDOWN */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Cooldown:{" "}
                <span className="font-mono text-gray-900">
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
                className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-black"
              />
              <div className="flex justify-between text-xs text-gray-400 mt-1">
                <span>30m</span>
                <span>4h</span>
              </div>
              <p className="text-xs text-gray-400 mt-1">
                Minimum time between repeat alerts for the same unchanged bet
              </p>
            </div>
          </div>

          {/* ACTION BUTTONS */}
          <div className="flex gap-3 mt-8">
            <button
              onClick={handleSave}
              disabled={saveStatus === "saving"}
              className="bg-gray-900 text-white px-5 py-2 rounded hover:bg-gray-700 disabled:opacity-50 text-sm font-medium"
            >
              {saveStatus === "saving" && "Saving..."}
              {saveStatus === "saved" && "Saved!"}
              {saveStatus === "error" && "Error - Try Again"}
              {saveStatus === "idle" && "Save Settings"}
            </button>

            <button
              onClick={handleTest}
              disabled={testStatus === "sending"}
              className="bg-gray-100 text-gray-700 px-5 py-2 rounded hover:bg-gray-200 disabled:opacity-50 text-sm font-medium"
            >
              {testStatus === "sending" && "Sending..."}
              {testStatus === "sent" && "Sent! Check your phone"}
              {testStatus === "error" && "Error - Try Again"}
              {testStatus === "idle" && "Send Test Notification"}
            </button>
          </div>
        </div>

        {/* PAPER TRADING SETTINGS CARD */}
        <div className="bg-white shadow-sm rounded-lg border border-gray-200 p-6 mb-6">
          <h2 className="text-lg font-semibold mb-1">Paper Trading</h2>
          <p className="text-sm text-gray-500 mb-6">
            Configure how many historical paper bets are loaded for analysis.
            Higher numbers give better data but use more memory.
          </p>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Bet History Limit:{" "}
              <span className="font-mono text-gray-900">
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
              className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-black"
            />
            <div className="flex justify-between text-xs text-gray-400 mt-1">
              <span>500</span>
              <span>50,000</span>
            </div>
            <p className="text-xs text-gray-400 mt-1">
              Default: 5,000 bets. Higher values will load more data into the browser.
            </p>
          </div>
        </div>

        {/* RULES CARDS */}
        <div className="mb-6">
          <h2 className="text-lg font-semibold mb-1">Notification Rules</h2>
          <p className="text-sm text-gray-500 mb-4">
            A bet triggers a notification if it matches <strong>either</strong> rule.
            Each rule has its own filters.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {rules.map((rule) => renderRuleCard(rule))}
          </div>
        </div>

        {/* NOTIFICATION LOG CARD */}
        <div className="bg-white shadow-sm rounded-lg border border-gray-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100">
            <h2 className="text-lg font-semibold">Recent Notifications</h2>
            <p className="text-xs text-gray-400 mt-0.5">
              Last 20 alerts sent by the scanner
            </p>
          </div>

          {log.length === 0 ? (
            <div className="px-6 py-10 text-center text-gray-400 text-sm">
              No notifications sent yet.
            </div>
          ) : (
            <table className="w-full text-sm text-left">
              <thead className="bg-gray-100 text-gray-600 font-medium border-b">
                <tr>
                  <th className="px-6 py-3">Sent At</th>
                  <th className="px-6 py-3">Bet</th>
                  <th className="px-6 py-3 text-right">Odds</th>
                  <th className="px-6 py-3 text-right">EV</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {log.map((entry) => (
                  <tr key={entry.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4 text-gray-400 text-xs whitespace-nowrap">
                      {new Date(entry.notified_at).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </td>
                    <td className="px-6 py-4 text-gray-700 font-mono text-xs">
                      {entry.bet_key}
                    </td>
                    <td className="px-6 py-4 text-right font-mono">
                      {entry.danske_odds.toFixed(2)}
                    </td>
                    <td className="px-6 py-4 text-right font-mono text-green-600 font-medium">
                      +{entry.ev_percent.toFixed(1)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </main>
  );
}