/* ------------------------------------------------------------------ */
/* Shared rule types + helpers - used by the Strategy page and Settings  */
/* page. Mirrors backend NotificationRule (/api/notification-rules).  */
/* ------------------------------------------------------------------ */

export interface StrategyRule {
  rule_number: number;
  name?: string | null;
  enabled: boolean;
  min_ev: number;
  max_ev: number;
  min_odds: number;
  max_odds: number;
  market_types: string[];
  min_minutes: number | null;
  max_minutes: number | null;
}

/* Range bounds used by both pages' EV / time controls */
export const RULE_EV_MIN = 0;
export const RULE_EV_MAX = 10;
export const RULE_HOUR_MIN = 0;
export const RULE_HOUR_MAX = 23;
export const ALL_MARKET_TYPES = ["Spread", "Total", "MoneyLine"];

export const DEFAULT_RULE_VALUES: Omit<StrategyRule, "rule_number" | "name"> = {
  enabled: false,
  min_ev: 3.5,
  max_ev: RULE_EV_MAX,
  min_odds: 1.6,
  max_odds: 2.5,
  market_types: [...ALL_MARKET_TYPES],
  min_minutes: null,
  max_minutes: null,
};

export function ruleDisplayName(rule: Pick<StrategyRule, "rule_number" | "name">): string {
  const name = rule.name?.trim();
  return name ? name : `Rule ${rule.rule_number}`;
}

export function ruleSummary(rule: StrategyRule): string {
  const minH = rule.min_minutes == null ? "–" : `${Math.round(rule.min_minutes / 60)}h`;
  const maxH = rule.max_minutes == null ? "–" : `${Math.round(rule.max_minutes / 60)}h`;
  return `EV ${rule.min_ev}–${rule.max_ev}% · T ${minH}–${maxH} · Odds ${rule.min_odds}–${rule.max_odds}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
export async function fetchRules(): Promise<StrategyRule[]> {
  try {
    const res = await fetch("/api/notification-rules");
    if (!res.ok) return [];
    const json = await res.json();
    return Array.isArray(json.rules)
      ? json.rules.map((r: any) => normalizeRule(r)).filter(Boolean) as StrategyRule[]
      : [];
  } catch {
    return [];
  }
}

export async function saveRules(rules: StrategyRule[]): Promise<boolean> {
  try {
    const res = await fetch("/api/notification-rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rules),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function normalizeRule(r: any): StrategyRule | null {
  if (!r || r.rule_number == null) return null;
  return {
    rule_number: Number(r.rule_number),
    name: r.name ?? null,
    enabled: r.enabled === "true" || r.enabled === true,
    min_ev: parseFloat(r.min_ev ?? 0),
    max_ev: parseFloat(r.max_ev ?? RULE_EV_MAX),
    min_odds: parseFloat(r.min_odds ?? 1),
    max_odds: parseFloat(r.max_odds ?? 100),
    market_types: Array.isArray(r.market_types) ? r.market_types : [...ALL_MARKET_TYPES],
    min_minutes: r.min_minutes == null ? null : Number(r.min_minutes),
    max_minutes: r.max_minutes == null ? null : Number(r.max_minutes),
  };
}
