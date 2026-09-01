from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import tls_client
import requests
import os
import time
from datetime import datetime, timedelta
from dotenv import load_dotenv
from thefuzz import process
import sqlite3
from pydantic import BaseModel
from typing import Optional
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.jobstores.base import JobLookupError
import pytz
import json
from strategy_analysis import build_evidence
from strategy_model import build_model, build_sweep

# Load environment variables
load_dotenv()
API_KEY = os.getenv("API_KEY")
NTFY_TOPIC = os.getenv("NTFY_TOPIC")

app = FastAPI()

# Initialize Scheduler
scheduler = BackgroundScheduler()
scheduler.start()

def run_scheduled_scan():
    """
    The Heartbeat: Runs automatically to harvest data.
    Checks time to ensure we only run during active hours (07:00 - 23:00).
    """
    # 1. Check Business Hours (Server Time)
    current_hour = datetime.now().hour
    if current_hour < 7:
        print(f"💤 Skipping Scan (Night Hours: {current_hour}:00)")
        return

    print("⏰ Starting Scheduled Market Scan...")

    # 2. Fetch Data (Force Fresh Pinnacle = 1 Credit)
    danske = fetch_danske_spil()
    if not danske:
        print("❌ Scheduled Scan: Danske Spil failed.")
        return

    # We force refresh=True to get the new snapshot
    pinnacle = fetch_pinnacle_cached(require_fresh=True)
    
    # 3. Analyze & Log
    # This automatically calls our new log_paper_bets function
    opportunities = run_analysis(danske, pinnacle)
    log_paper_bets(opportunities)
    check_and_notify(opportunities)
    
    print(f"✅ Scheduled Scan Complete. Processed {len(opportunities)} opps.")

# --- CONFIGURATION ---
# Allow your Next.js app (running on port 3000) to talk to this API
origins = ["http://localhost:3000"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# CACHING SETTINGS
CACHE_DURATION = 600  # Seconds (10 minutes) to keep Pinnacle data
pinnacle_cache = {
    "last_updated": 0,
    "data": []
}

# Global variable to store the latest quota info
latest_quota = {
    "remaining": "Unknown",
    "used": "Unknown"
}

# ---------------------------------------------------------
# CLV SNIPER LOGIC (Background Tasks)
# ---------------------------------------------------------

def perform_clv_snapshot():
    """
    This function runs 10 minutes before game time.
    It forces a paid API call to capture the Closing Line.
    """
    print(f"⏰ CLV SNIPER FIRED: Fetching fresh odds to capture CLV...")
    
    # 1. Force Fetch (Spend 1 Credit)
    pinnacle_data = fetch_pinnacle_cached(require_fresh=True)
    
    # 2. Update Database
    update_clv_for_placed_bets(pinnacle_data)
    print("✅ CLV Snapshot Complete.")

def schedule_clv_job(game_start_iso: str):
    """
    Schedules a job to run 10 minutes before the given game start time.
    Uses the timestamp as the Job ID to prevent duplicate calls.
    """
    try:
        # 1. Parse Time
        # API times are usually UTC (Z). We handle them as UTC.
        game_time = datetime.fromisoformat(game_start_iso.replace('Z', '+00:00'))
        
        # 2. Calculate Snapshot Time (10 mins before)
        snapshot_time = game_time - timedelta(minutes=10)
        
        # If the time has already passed, don't schedule
        if snapshot_time < datetime.now(pytz.utc):
            print(f"⚠️ Game at {game_start_iso} is too soon/past to schedule CLV sniper.")
            return

        # 3. Schedule the Job
        # ID is crucial: If we already have a job for this specific time,
        # 'replace_existing=True' ensures we don't pay double.
        job_id = f"clv_{game_start_iso}"
        
        scheduler.add_job(
            perform_clv_snapshot,
            'date',
            run_date=snapshot_time,
            id=job_id,
            replace_existing=True
        )
        
        print(f"🎯 CLV Sniper armed for: {snapshot_time} (Job ID: {job_id})")
        
    except Exception as e:
        print(f"Error scheduling CLV job: {e}")

def restore_clv_jobs():
    """
    On server startup, look at all Pending bets and re-arm the snipers.
    """
    print("re-arming CLV Snipers for pending bets...")
    conn = sqlite3.connect(DB_NAME)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    cursor.execute("SELECT DISTINCT game_starts_at FROM bets WHERE status = 'Pending'")
    rows = cursor.fetchall()
    
    count = 0
    for row in rows:
        if row['game_starts_at']:
            schedule_clv_job(row['game_starts_at'])
            count += 1
            
    conn.close()
    print(f"Re-armed {count} CLV jobs.")

# ---------------------------------------------------------
# 1. DATA FETCHING: DANSKE SPIL (Free - No Cache Needed)
# ---------------------------------------------------------
def fetch_danske_spil():
    print("Fetching Danske Spil data...")
    session = tls_client.Session(
        client_identifier="chrome_120",
        random_tls_extension_order=True
    )

    now = datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')
    future = (datetime.utcnow() + timedelta(days=1)).strftime('%Y-%m-%dT%H:%M:%SZ')
    
    # NBA ID: 18608. Change this ID for other leagues.
    league_id = "18608" 
    url = f"https://content.sb.danskespil.dk/content-service/api/v1/q/event-list?startTimeFrom={now}&startTimeTo={future}&maxEvents=50&drilldownTagIds={league_id}&includeChildMarkets=true&prioritisePrimaryMarkets=true"

    headers = {
        "authority": "content.sb.danskespil.dk",
        "accept": "application/json",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }

    try:
        response = session.get(url, headers=headers)
        data = response.json()
        return parse_danske_spil(data)
    except Exception as e:
        print(f"Error fetching Danske Spil: {e}")
        return []

def parse_danske_spil(json_response):
    grouped_events = []
    raw_events = json_response.get('data', {}).get('events', [])
    if not raw_events:
        raw_events = json_response.get('events', [])

    for event in raw_events:
        home_team_name = "Unknown"
        away_team_name = "Unknown"
        for t in event.get('teams', []):
            if t['side'] == 'HOME': home_team_name = t['name']
            elif t['side'] == 'AWAY': away_team_name = t['name']

        clean_event = {
            "id": event['id'],
            "home_team": home_team_name,
            "away_team": away_team_name,
            "commence_time": event.get('startTime'),
            "league": "NBA",
            "markets": [] 
        }
        
        for market in event.get('markets', []):
            group_code = market.get('groupCode')
            
            if group_code == "MONEY_LINE":
                for outcome in market.get('outcomes', []):
                    clean_event['markets'].append({
                        "type": "MoneyLine",
                        "selection": outcome['name'],
                        "odds": extract_decimal(outcome['prices'][0]),
                        "handicap_line": None
                    })

            elif group_code in ["HANDICAP_2_WAY", "TOTAL_POINTS_OVER/UNDER"]:
                market_type = "Spread" if group_code == "HANDICAP_2_WAY" else "Total"
                for outcome in market.get('outcomes', []):
                    price_data = outcome['prices'][0]
                    # Try specific line, fallback to market value
                    specific_line = price_data.get('handicapLow') or price_data.get('handicapHigh')
                    final_line = float(specific_line) if specific_line else market.get('handicapValue')

                    clean_event['markets'].append({
                        "type": market_type,
                        "selection": outcome['name'],
                        "odds": extract_decimal(price_data),
                        "handicap_line": final_line
                    })
        
        if clean_event['markets']:
            grouped_events.append(clean_event)
            
    return grouped_events

def extract_decimal(price_data):
    val = price_data.get('decimal')
    if isinstance(val, dict):
        return float(val.get('parsedValue'))
    return float(val)

# ---------------------------------------------------------
# NOTIFICATION SYSTEM
# ---------------------------------------------------------

def load_notification_config():
    """Loads global notification settings from DB."""
    defaults = {
        "enabled": "false",
        "ntfy_topic": NTFY_TOPIC or "",
        "cooldown_minutes": "120",
        "paper_bets_limit": "5000",
    }

    try:
        conn = sqlite3.connect(DB_NAME)
        cursor = conn.cursor()
        cursor.execute("SELECT key, value FROM notification_config")
        rows = cursor.fetchall()
        conn.close()

        config = dict(rows) if rows else {}

        for key, default_val in defaults.items():
            if key not in config:
                config[key] = default_val

        return config
    except Exception as e:
        print(f"Error loading notification config: {e}")
        return defaults

def save_notification_config(config_dict):
    """Upserts all config key/value pairs to DB."""
    try:
        conn = sqlite3.connect(DB_NAME)
        cursor = conn.cursor()
        for key, value in config_dict.items():
            cursor.execute(
                "INSERT OR REPLACE INTO notification_config (key, value) VALUES (?, ?)",
                (key, str(value))
            )
        conn.commit()
        conn.close()
        print("Notification config saved.")
    except Exception as e:
        print(f"Error saving notification config: {e}")

def load_notification_rules():
    """Loads both notification rules from DB."""
    try:
        conn = sqlite3.connect(DB_NAME)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM notification_rules ORDER BY rule_number ASC")
        rows = cursor.fetchall()
        conn.close()
        return [dict(row) for row in rows]
    except Exception as e:
        print(f"Error loading notification rules: {e}")
        return []


def save_notification_rules(rules):
    """Saves rules to DB — inserts new rule_numbers, replaces existing ones (shared rule store)."""
    try:
        conn = sqlite3.connect(DB_NAME)
        cursor = conn.cursor()
        for rule in rules:
            market_types = rule["market_types"]
            if isinstance(market_types, list):
                market_types = ",".join(market_types)
            cursor.execute('''
                INSERT OR REPLACE INTO notification_rules
                (rule_number, name, enabled, min_ev, max_ev, min_odds, max_odds,
                 market_types, min_minutes, max_minutes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''', (
                int(rule["rule_number"]),
                rule.get("name"),
                rule["enabled"],
                float(rule["min_ev"]),
                float(rule.get("max_ev", 10.0)),
                float(rule["min_odds"]),
                float(rule["max_odds"]),
                market_types,
                rule.get("min_minutes"),
                rule.get("max_minutes"),
            ))
        conn.commit()
        conn.close()
        print("Notification rules saved.")
    except Exception as e:
        print(f"Error saving notification rules: {e}")

def send_ntfy_notification(title, message, topic):
    """Sends a push notification via Ntfy.sh."""
    try:
        response = requests.post(
            f"https://ntfy.sh/{topic}",
            data=message.encode("utf-8"),
            headers={
                "Title": title,
                "Priority": "high",
                "Tags": "basketball",
            }
        )
        if response.ok:
            print(f"✅ Notification sent to topic '{topic}'")
        else:
            print(f"❌ Ntfy error: {response.status_code} - {response.text}")
    except Exception as e:
        print(f"❌ Failed to send notification: {e}")


def check_and_notify(opportunities):
    """
    Filters opportunities against notification rules,
    checks deduplication, and sends qualifying bets.
    """
    try:
        config = load_notification_config()

        # 1. Is the system enabled?
        if config.get("enabled", "false") != "true":
            return

        topic = config.get("ntfy_topic", "")
        if not topic:
            print("⚠️ Notifications enabled but no topic configured.")
            return

        cooldown_minutes = int(config.get("cooldown_minutes", "120"))

        # 2. Load rules
        rules = load_notification_rules()
        active_rules = [r for r in rules if r.get('enabled') == 'true']

        if not active_rules:
            return

        # 3. Check each opportunity against each rule
        qualifying = {}  # Use dict keyed by opp id to deduplicate across rules
        now = datetime.now()

        for opp in opportunities:
            if opp["id"] in qualifying:
                continue  # Already matched by another rule

            for rule in active_rules:
                # A. EV check
                if opp["ev"] < rule["min_ev"]:
                    continue
                if rule.get("max_ev") is not None and opp["ev"] > rule["max_ev"]:
                    continue

                # B. Odds range check
                if opp["danske_odds"] < rule["min_odds"]:
                    continue
                if opp["danske_odds"] > rule["max_odds"]:
                    continue

                # C. Market type check
                allowed_markets = [m.strip() for m in rule["market_types"].split(",")]
                if opp["type"] not in allowed_markets:
                    continue

                # D. Time window check
                if rule["min_minutes"] is not None and rule["max_minutes"] is not None:
                    try:
                        commence = datetime.fromisoformat(
                            opp["commence_time"].replace('Z', '+00:00')
                        )
                        now_utc = datetime.now(pytz.utc)
                        minutes_until = (commence - now_utc).total_seconds() / 60

                        if minutes_until < rule["min_minutes"]:
                            continue
                        if minutes_until > rule["max_minutes"]:
                            continue
                    except Exception:
                        continue  # If time parsing fails, skip this check

                # Passed all filters for this rule
                qualifying[opp["id"]] = opp
                break  # No need to check other rules for this opp

        if not qualifying:
            return

        # 4. Check deduplication
        conn = sqlite3.connect(DB_NAME)
        cursor = conn.cursor()
        to_notify = []

        for opp in qualifying.values():
            cursor.execute(
                "SELECT danske_odds, ev_percent, notified_at FROM notification_log "
                "WHERE bet_key = ? ORDER BY id DESC LIMIT 1",
                (opp["id"],)
            )
            row = cursor.fetchone()

            if row is None:
                to_notify.append(opp)
            else:
                last_odds, last_ev, last_notified_str = row
                last_notified = datetime.fromisoformat(last_notified_str)
                minutes_since = (now - last_notified).total_seconds() / 60

                odds_changed = abs(opp["danske_odds"] - last_odds) >= 0.02

                if odds_changed:
                    to_notify.append(opp)
                elif minutes_since >= cooldown_minutes:
                    to_notify.append(opp)

        if not to_notify:
            conn.close()
            return

        # 5. Build the notification message (batched)
        lines = []
        for opp in to_notify:
            line = (
                f"{opp['match']}\n"
                f"  {opp['selection']}"
                + (f" ({opp['line']})" if opp['line'] else "")
                + f" ({opp['type']})\n"
                f"  Danske: {opp['danske_odds']:.2f} | Fair: {opp['fair_odds']:.2f} | EV: +{opp['ev']:.1f}%"
            )
            lines.append(line)

        title = f"{len(to_notify)} Edge{'s' if len(to_notify) > 1 else ''} Found"
        message = "\n\n".join(lines)

        # 6. Send the notification
        send_ntfy_notification(title, message, topic)

        # 7. Log all notified bets
        for opp in to_notify:
            cursor.execute(
                "INSERT INTO notification_log (bet_key, danske_odds, ev_percent) VALUES (?, ?, ?)",
                (opp["id"], opp["danske_odds"], opp["ev"])
            )

        conn.commit()
        conn.close()

        print(f"📱 Notified about {len(to_notify)} bets.")

    except Exception as e:
        print(f"❌ Error in check_and_notify: {e}")

# ---------------------------------------------------------
# 2. DATA FETCHING: PINNACLE (Quota Management)
# ---------------------------------------------------------
def fetch_pinnacle_cached(require_fresh=True):
    global pinnacle_cache, latest_quota
    current_time = time.time()

    # 1. If we DON'T require fresh data, just return what we have
    # (unless it's completely empty, then we must fetch)
    if not require_fresh and pinnacle_cache["data"]:
        print("Returning Stale/Cached Data (User requested no refresh)")
        return pinnacle_cache["data"]

    # 2. Standard Logic: Check Timer
    if pinnacle_cache["data"] and (current_time - pinnacle_cache["last_updated"] < CACHE_DURATION):
        print("Returning Cached Pinnacle Data (Timer valid)")
        return pinnacle_cache["data"]

    print("Fetching New Pinnacle Data (Using Quota)...")

    
    SPORT_KEY = 'basketball_nba'
    BOOKMAKERS = 'pinnacle'
    #MARKETS = 'h2h,spreads,totals' 
    MARKETS = 'spreads' 
    
    url = f'https://api.the-odds-api.com/v4/sports/{SPORT_KEY}/odds'
    params = {
        'apiKey': API_KEY,
        'bookmakers': BOOKMAKERS, 
        'markets': MARKETS,
        'oddsFormat': 'decimal',
    }

    try:
        response = requests.get(url, params=params)
        
        # --- CAPTURE HEADERS ---
        latest_quota["remaining"] = response.headers.get('x-requests-remaining', 'Unknown')
        latest_quota["used"] = response.headers.get('x-requests-used', 'Unknown')

        response.raise_for_status()
        
        # Parse immediately before caching
        raw_data = response.json()
        clean_data = parse_pinnacle_data(raw_data)

        # Save to Database immediately
        save_snapshot_to_db(clean_data)
        
        # Update Cache
        pinnacle_cache["data"] = clean_data
        pinnacle_cache["last_updated"] = current_time
        
        return clean_data
    except Exception as e:
        print(f"Error fetching Pinnacle: {e}")
        # If API fails, return old cache if it exists, else empty list
        return pinnacle_cache["data"] if pinnacle_cache["data"] else []

def parse_pinnacle_data(api_response):
    if not api_response: return []
    clean_data = []
    for event in api_response:
        if not event.get('bookmakers'): continue
        clean_event = {
            "home_team": event['home_team'],
            "away_team": event['away_team'],
            "commence_time": event['commence_time'],
            "markets": event['bookmakers'][0]['markets']
        }
        clean_data.append(clean_event)
    return clean_data

def update_clv_for_placed_bets(pinnacle_events):
    """
    Loops through pending bets in DB. If the game is found in the fresh
    Pinnacle data, update the 'closing_odds' with the current Pinnacle price.
    """
    conn = sqlite3.connect(DB_NAME)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    # Get all pending bets
    cursor.execute("SELECT * FROM bets WHERE status = 'Pending'")
    pending_bets = cursor.fetchall()
    
    updates_made = 0
    pinnacle_home_teams = [p['home_team'] for p in pinnacle_events]

    if not pinnacle_home_teams:
        conn.close()
        return

    for bet in pending_bets:
        # 1. Find the matching Pinnacle Event
        result = process.extractOne(bet['match_name'].split(" vs ")[0], pinnacle_home_teams)
        if not result:
            continue
        match_name, score = result
        if score < 85: continue

        p_event = next(p for p in pinnacle_events if p['home_team'] == match_name)
        
        # 2. Find the specific market and selection
        # Map our stored types back to API keys
        p_market_key = {'MoneyLine': 'h2h', 'Spread': 'spreads', 'Total': 'totals'}.get(bet['market_type'])
        if not p_market_key or not p_event.get('markets'): continue
        
        p_target_market = next((m for m in p_event['markets'] if m['key'] == p_market_key), None)
        if not p_target_market: continue
        
        # 3. Calculate Fair Odds (The "CLV")
        fair_probs = calculate_fair_probability(p_target_market['outcomes'])
        
        # Fuzzy match the selection name (e.g. "Lakers")
        p_selection, sel_score = process.extractOne(bet['selection'], list(fair_probs.keys()))
        if sel_score < 85: continue

        # 4. Update Database
        current_fair_prob = fair_probs[p_selection]
        current_fair_odds = round(1 / current_fair_prob, 2)
        
        cursor.execute(
            "UPDATE bets SET closing_odds = ? WHERE id = ?", 
            (current_fair_odds, bet['id'])
        )
        updates_made += 1

    if updates_made > 0:
        print(f"Updated CLV for {updates_made} pending bets.")
        conn.commit()
    
    conn.close()

def find_clv_for_paper_bet(bet_row):
    """
    Scans the market_snapshots table for the snapshot closest 
    to the game start time to estimate CLV.
    """
    game_start = bet_row['commence_time']
    # 1. Find the latest snapshot BEFORE or AT game start
    conn = sqlite3.connect(DB_NAME)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    cursor.execute('''
        SELECT raw_json FROM market_snapshots 
        WHERE timestamp <= ? 
        ORDER BY timestamp DESC 
        LIMIT 1
    ''', (game_start,))
    
    row = cursor.fetchone()
    conn.close()
    
    if not row:
        return None # No data found before game start
        
    pinnacle_events = json.loads(row['raw_json'])
    
    # 2. Extract Data (Reusing your existing logic)
    # We need to find the specific match and market in this old snapshot
    pinnacle_home_teams = [p['home_team'] for p in pinnacle_events]
    
    if not pinnacle_home_teams:
        return None
    
    # Fuzzy match the team name
    result = process.extractOne(bet_row['match_name'].split(" vs ")[0], pinnacle_home_teams)
    if not result:
        return None
    match_name, score = result
    if score < 85: return None

    p_event = next(p for p in pinnacle_events if p['home_team'] == match_name)
    
    # Map Market Type
    p_market_key = {'MoneyLine': 'h2h', 'Spread': 'spreads', 'Total': 'totals'}.get(bet_row['market_type'])
    if not p_market_key or not p_event.get('markets'): return None
    
    p_target_market = next((m for m in p_event['markets'] if m['key'] == p_market_key), None)
    if not p_target_market: return None
    
    # Calculate Fair Odds
    fair_probs = calculate_fair_probability(p_target_market['outcomes'])
    
    # Fuzzy match selection
    p_selection, sel_score = process.extractOne(bet_row['selection'], list(fair_probs.keys()))
    if sel_score < 85: return None
    
    # Return the Fair Odds (CLV)
    fair_prob = fair_probs[p_selection]
    return round(1 / fair_prob, 2)

# ---------------------------------------------------------
# 3. ANALYSIS LOGIC
# ---------------------------------------------------------
def calculate_fair_probability(pinnacle_outcomes):
    implied_probs = [1/o['price'] for o in pinnacle_outcomes if o['price'] > 1]
    total_implied = sum(implied_probs)
    # Normalize to remove vig
    return {o['name']: (1/o['price']) / total_implied for o in pinnacle_outcomes if o['price'] > 1}

def run_analysis(danske_events, pinnacle_events, min_match_score=80):
    results = []
    pinnacle_home_teams = [p['home_team'] for p in pinnacle_events]

    for d_event in danske_events:
        match_name, score = process.extractOne(d_event['home_team'], pinnacle_home_teams)
        if score < min_match_score: continue

        p_event = next(p for p in pinnacle_events if p['home_team'] == match_name)
        
        for d_market in d_event['markets']:
            p_key_map = {'MoneyLine': 'h2h', 'Spread': 'spreads', 'Total': 'totals'}
            p_market_key = p_key_map.get(d_market['type'])
            
            if not p_market_key or not p_event.get('markets'): continue
            
            p_target_market = next((m for m in p_event['markets'] if m['key'] == p_market_key), None)
            if not p_target_market: continue

            fair_probs = calculate_fair_probability(p_target_market['outcomes'])

            d_selection = d_market['selection']
            p_selection, name_score = process.extractOne(d_selection, list(fair_probs.keys()))
            if name_score < min_match_score: continue

            # Line Matching Logic
            d_line = d_market.get('handicap_line')
            prob_adjustment = 0.0
            is_valid = True

            if d_market['type'] in ['Spread', 'Total']:
                p_outcome = next((o for o in p_target_market['outcomes'] if o['name'] == p_selection), None)
                p_line = p_outcome.get('point') if p_outcome else None

                if d_line is None or p_line is None:
                    is_valid = False
                else:
                    diff = float(d_line) - float(p_line)
                    if abs(diff) < 0.1:
                        pass # Exact match
                    elif abs(diff) <= 1.6:
                        # Adjust fair prob based on line difference
                        factor = 0.035 if d_market['type'] == 'Spread' else 0.02
                        direction = -1 if (d_market['type'] == 'Total' and "Over" in d_selection) else 1
                        if d_market['type'] == 'Spread': direction = 1 
                        
                        # Simplified logic for this example:
                        # If we are getting extra points (Spread), it's good.
                        # If we are getting lower total on Over, it's good.
                        prob_adjustment = 0 # keeping simple for phase 1
                    else:
                        is_valid = False # Line too far off
            
            if not is_valid: continue

            d_odds = d_market['odds']
            fair_prob = fair_probs[p_selection] + prob_adjustment
            ev_percent = (d_odds * fair_prob) - 1

            if ev_percent > -0.05: # Return anything better than -5% EV
                # Determine league from the event data, default to 'NBA'
                league = d_event.get('league', 'NBA')
                results.append({
                    "id": f"{d_event['home_team']}-{d_market['type']}-{d_selection}-{d_line}", # Unique key for React
                    "event_id": d_event['id'],
                    "match": f"{d_event['home_team']} vs {d_event['away_team']}",
                    "commence_time": d_event['commence_time'],
                    "type": d_market['type'],
                    "selection": d_selection,
                    "line": d_line,
                    "danske_odds": d_odds,
                    "fair_odds": round(1/fair_prob, 2) if fair_prob > 0 else 0,
                    "ev": round(ev_percent * 100, 2),
                    "league": league
                })

    return sorted(results, key=lambda x: x['ev'], reverse=True)


# ---------------------------------------------------------
# 4. DATABASE SETUP (SQLite)
# ---------------------------------------------------------
#DB_NAME = "bets.db"
DB_NAME = "data/bets.db" 

def init_db():
    conn = sqlite3.connect(DB_NAME)
    cursor = conn.cursor()
    
    # 1. EXISTING TABLE
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS bets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            match_name TEXT,
            selection TEXT,
            market_type TEXT,
            handicap REAL,
            danske_odds REAL,
            fair_odds REAL,
            ev_percent REAL,
            stake REAL,
            status TEXT DEFAULT 'Pending',
            result_score TEXT,
            closing_odds REAL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            game_starts_at TEXT
        )
    ''')

    # 2. TABLE: MARKET SNAPSHOTS
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS market_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            raw_json TEXT
        )
    ''')

    # 3. TABLE: PAPER BETS
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS paper_bets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            snapshot_id INTEGER,
            match_name TEXT,
            selection TEXT,
            market_type TEXT,
            handicap REAL,
            danske_odds REAL,
            pinnacle_odds REAL,
            closing_odds REAL,
            ev_percent REAL,
            commence_time TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            status TEXT DEFAULT 'Pending',
            result_score TEXT,
            league TEXT DEFAULT 'NBA',
            FOREIGN KEY(snapshot_id) REFERENCES market_snapshots(id)
        )
    ''')

    # 4. NOTIFICATION CONFIG
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS notification_config (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            key TEXT UNIQUE,
            value TEXT
        )
    ''')

    # 5. NOTIFICATION LOG
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS notification_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            bet_key TEXT,
            danske_odds REAL,
            ev_percent REAL,
            notified_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    # 5.5 NOTIFICATION RULES (shared rule store: used by notifications + strategy page)
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS notification_rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            rule_number INTEGER UNIQUE,
            name TEXT,
            enabled TEXT DEFAULT 'false',
            min_ev REAL DEFAULT 3.5,
            max_ev REAL DEFAULT 10.0,
            min_odds REAL DEFAULT 1.60,
            max_odds REAL DEFAULT 2.50,
            market_types TEXT DEFAULT 'Spread,Total,MoneyLine',
            min_minutes INTEGER,
            max_minutes INTEGER
        )
    ''')

    # 6. INDICES
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_paper_bets_match ON paper_bets(match_name)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_paper_bets_time ON paper_bets(timestamp)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_snapshots_time ON market_snapshots(timestamp)')

    conn.commit()
    conn.close()
    print("Database tables and indices checked/created.")

    # Migration: Add league column to paper_bets if missing (for existing DBs)
    _migrate_add_league_column()

    # Migration: Add shared-rule columns (name, max_ev) if missing
    _migrate_add_rule_columns()

def _migrate_add_league_column():
    """Add league column to paper_bets if it doesn't exist yet."""
    try:
        conn = sqlite3.connect(DB_NAME)
        cursor = conn.cursor()
        cursor.execute("ALTER TABLE paper_bets ADD COLUMN league TEXT DEFAULT 'NBA'")
        conn.commit()
        print("✅ Migration: Added league column to paper_bets.")
        conn.close()
    except sqlite3.OperationalError:
        # Column already exists — no problem
        pass

def _migrate_add_rule_columns():
    """Add name/max_ev columns to notification_rules if missing (unified rule store).
    Backfills max_ev so notification filtering stays active for legacy rules."""
    try:
        conn = sqlite3.connect(DB_NAME)
        cursor = conn.cursor()
        changed = False
        cols = {row[1] for row in cursor.execute("PRAGMA table_info(notification_rules)").fetchall()}
        if "name" not in cols:
            cursor.execute("ALTER TABLE notification_rules ADD COLUMN name TEXT")
            changed = True
        if "max_ev" not in cols:
            cursor.execute("ALTER TABLE notification_rules ADD COLUMN max_ev REAL")
            changed = True
        # Backfill existing rows so max_ev is never NULL (legacy rules)
        cursor.execute("UPDATE notification_rules SET max_ev = ? WHERE max_ev IS NULL", (10.0,))
        if changed:
            print("✅ Migration: Added rule columns (name, max_ev).")
        conn.commit()
        conn.close()
    except sqlite3.OperationalError:
        pass

def migrate_to_rules():
    """
    One-time migration: moves per-bet filters from notification_config
    into the new notification_rules table. Runs safely on every startup.
    """
    conn = sqlite3.connect(DB_NAME)
    cursor = conn.cursor()

    # 1. Check if rules already exist
    cursor.execute("SELECT COUNT(*) FROM notification_rules")
    count = cursor.fetchone()[0]

    if count > 0:
        conn.close()
        return  # Already migrated

    print("🔄 Migrating notification config to rules...")

    # 2. Read existing config values (if any)
    cursor.execute("SELECT key, value FROM notification_config")
    old_config = dict(cursor.fetchall()) if cursor.fetchall else {}
    
    # Re-read because fetchall consumed the cursor
    cursor.execute("SELECT key, value FROM notification_config")
    rows = cursor.fetchall()
    old_config = dict(rows) if rows else {}

    # 3. Insert Rule 1 (from existing config or defaults)
    cursor.execute('''
        INSERT INTO notification_rules 
        (rule_number, name, enabled, min_ev, max_ev, min_odds, max_odds, market_types, min_minutes, max_minutes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ''', (
        1,
        None,
        'true',
        float(old_config.get('min_ev', '3.5')),
        10.0,
        float(old_config.get('min_odds', '1.60')),
        float(old_config.get('max_odds', '2.50')),
        old_config.get('market_types', 'Spread,Total,MoneyLine'),
        None,  # No time filter
        None,
    ))

    # 4. Insert Rule 2 (disabled defaults)
    cursor.execute('''
        INSERT INTO notification_rules 
        (rule_number, name, enabled, min_ev, max_ev, min_odds, max_odds, market_types, min_minutes, max_minutes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ''', (
        2,
        None,
        'false',
        5.0,
        10.0,
        1.60,
        2.50,
        'Spread,Total,MoneyLine',
        None,
        None,
    ))

    # 5. Clean up old per-bet keys from notification_config
    old_keys = ['min_ev', 'min_odds', 'max_odds', 'market_types']
    for key in old_keys:
        cursor.execute("DELETE FROM notification_config WHERE key = ?", (key,))

    conn.commit()
    conn.close()
    print("✅ Migration complete. 2 rules created.")

# Helper funktion to save snapshot data to database
def save_snapshot_to_db(clean_data):
    """
    Saves the cleaned Pinnacle data to the database as a JSON string.
    Returns the ID of the new snapshot row.
    """
    try:
        conn = sqlite3.connect(DB_NAME)
        cursor = conn.cursor()
        
        # Convert the list of Python dictionaries to a text string
        json_str = json.dumps(clean_data)
        
        cursor.execute(
            "INSERT INTO market_snapshots (raw_json) VALUES (?)", 
            (json_str,)
        )
        new_id = cursor.lastrowid
        conn.commit()
        conn.close()
        print(f"📸 Snapshot saved to DB with ID: {new_id}")
        return new_id
    except Exception as e:
        print(f"Error saving snapshot: {e}")
        return None


def log_paper_bets(opportunities):
    """
    Iterates through opportunities. If EV > 0, checks if we already 
    have this EXACT bet (same odds/line) logged as the most recent entry.
    If it's new or changed, saves it to paper_bets.
    """
    if not opportunities:
        return

    conn = sqlite3.connect(DB_NAME)
    cursor = conn.cursor()

    # 1. Get the latest Snapshot ID to link these bets to
    cursor.execute("SELECT id FROM market_snapshots ORDER BY id DESC LIMIT 1")
    row = cursor.fetchone()
    current_snapshot_id = row[0] if row else None

    count_new = 0

    for op in opportunities:
        # Only track positive EV for paper betting
        if op['ev'] <= 0:
            continue

        # 2. Check the LAST logged bet for this specific match/selection
        cursor.execute('''
            SELECT danske_odds, handicap 
            FROM paper_bets 
            WHERE match_name = ? AND selection = ? AND market_type = ? 
            ORDER BY id DESC LIMIT 1
        ''', (op['match'], op['selection'], op['type']))
        
        last_entry = cursor.fetchone()

        # 3. COMPARE: Is this a new price/line?
        # If last_entry exists, check if data is identical.
        # We assume 'line' might be None, so we handle that.
        is_duplicate = False
        if last_entry:
            last_odds, last_handicap = last_entry
            current_handicap = op['line']
            
            # Treat None as equal to None
            lines_match = (last_handicap is None and current_handicap is None) or \
                          (last_handicap == current_handicap)
            
            if last_odds == op['danske_odds'] and lines_match:
                is_duplicate = True

        # 4. INSERT if not duplicate
        if not is_duplicate:
            # Determine league — for now hardcoded to NBA, expandable later
            league = op.get('league', 'NBA')
            cursor.execute('''
                INSERT INTO paper_bets (
                    snapshot_id, match_name, selection, market_type, 
                    handicap, danske_odds, pinnacle_odds, ev_percent, commence_time, league
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''', (
                current_snapshot_id,
                op['match'],
                op['selection'],
                op['type'],
                op['line'],
                op['danske_odds'],
                op['fair_odds'], # We store the "Fair" price as our benchmark
                op['ev'],
                op['commence_time'],
                league
            ))
            count_new += 1

    conn.commit()
    conn.close()
    if count_new > 0:
        print(f"📝 Logged {count_new} new/changed Paper Bets.")


def settle_paper_bets(scores_data=None):
    """
    Background task: Grades all pending PAPER bets.
    Reuses the existing grade_bet logic since column names are identical.
    """
    print("⚖️ Starting Paper Bet Settlement...")
    conn = sqlite3.connect(DB_NAME)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    # 1. Get Pending Paper Bets
    cursor.execute("SELECT * FROM paper_bets WHERE status = 'Pending'")
    pending = cursor.fetchall()
    
    if not pending:
        print("No pending paper bets to settle.")
        conn.close()
        return

    # 2. Get Scores (reuse if passed in, otherwise fetch fresh)
    if not scores_data:
        scores_data = fetch_nba_scores()
    if not scores_data:
        print("Could not fetch scores for settlement.")
        conn.close()
        return

    updated_count = 0
    
    # 3. Grade each bet
    for bet in pending:
        # A. GRADE RESULT
        new_status, result_str = grade_bet(dict(bet), scores_data)
        
        # B. CALCULATE CLV (New Step)
        clv_odds = find_clv_for_paper_bet(dict(bet))

        # Update if we have a result OR if we found CLV
        # (Sometimes we might find CLV before the game score is final, which is fine)
        if (new_status and new_status != 'Pending') or clv_odds:
            
            # Prepare Update
            # If game isn't over yet, keep status as is, but save CLV
            final_status = new_status if new_status else bet['status']
            final_result = result_str if result_str else bet['result_score']
            
            cursor.execute(
                "UPDATE paper_bets SET status = ?, result_score = ?, closing_odds = ? WHERE id = ?",
                (final_status, final_result, clv_odds, bet['id'])
            )
            updated_count += 1
            print(f"✅ Updated Paper Bet {bet['id']}: {final_status} (CLV: {clv_odds})")

    conn.commit()
    conn.close()
    print(f"🏁 Paper Settlement Complete. Updated {updated_count}/{len(pending)} bets.")

# STARTUP: Schedule the Heartbeat
# 'cron' trigger allows us to specify "every 90 minutes" somewhat loosely, 
# but 'interval' is easier. We handle the 7-23 check inside the function.

try:
    # Remove existing job if it exists (to prevent duplicates on reload)
    scheduler.remove_job('market_heartbeat')
except JobLookupError:
    pass

scheduler.add_job(
    run_scheduled_scan, 
    'interval', 
    minutes=90, 
    id='market_heartbeat',
    replace_existing=True
)

print("📅 Automated 'Heartbeat' Scanner scheduled (Every 90 mins).")

# SETTLEMENT: Run once a day at 5:00 AM
try:
    scheduler.remove_job('daily_settlement')
except JobLookupError:
    pass

scheduler.add_job(
    settle_paper_bets, 
    'cron', 
    hour=5,      # 05:00 AM
    minute=0, 
    id='daily_settlement',
    replace_existing=True
)
print("⚖️ Daily Settlement scheduled for 05:00 AM.")

# Run this on startup
init_db()
migrate_to_rules()  # One-time migration to rule-based notifications
restore_clv_jobs() # Restore jobs if server restarts

class BetRequest(BaseModel):
    match_name: str
    selection: str
    market_type: str
    handicap: Optional[float] = None
    danske_odds: float
    fair_odds: float
    ev_percent: float
    stake: float
    commence_time: str

class NotificationConfig(BaseModel):
    enabled: bool
    ntfy_topic: str
    cooldown_minutes: int
    paper_bets_limit: int = 5000

class NotificationRule(BaseModel):
    rule_number: int
    name: Optional[str] = None
    enabled: bool
    min_ev: float
    max_ev: float = 10.0
    min_odds: float
    max_odds: float
    market_types: list[str]
    min_minutes: Optional[int] = None
    max_minutes: Optional[int] = None

# ---------------------------------------------------------
# 5. API ENDPOINT
# ---------------------------------------------------------
@app.get("/api/opportunities")
def get_opportunities(refresh: bool = False):
    if not API_KEY:
        raise HTTPException(status_code=500, detail="API_KEY not set in .env file")

    # 1. Get Data
    danske_data = fetch_danske_spil()
    # If refresh=True, we ask for fresh data (checks timer).
    # If refresh=False, we accept whatever is in memory.
    pinnacle_data = fetch_pinnacle_cached(require_fresh=refresh)
    
    if not danske_data: # If Danske fails, we can't do anything
        return {"message": "Error fetching Danske Spil", "data": []}
    
    # If we have no Pinnacle data at all (first run), we might return empty
    if not pinnacle_data:
        # Optional: Force fetch if it's the very first run ever
        pinnacle_data = fetch_pinnacle_cached(require_fresh=True)

    # ... piggyback update ...
    update_clv_for_placed_bets(pinnacle_data)

    opportunities = run_analysis(danske_data, pinnacle_data)

    log_paper_bets(opportunities)
    
    return {
        "timestamp": datetime.now().isoformat(),
        "pinnacle_age": pinnacle_cache["last_updated"],
        "quota_remaining": latest_quota["remaining"],
        "count": len(opportunities),
        "data": opportunities
    }

# ---------------------------------------------------------
# BETTING ENDPOINTS
# ---------------------------------------------------------

@app.post("/api/place-bet")
def place_bet(bet: BetRequest):
    try:
        final_time = bet.commence_time if bet.commence_time else datetime.utcnow().isoformat()

        conn = sqlite3.connect(DB_NAME)
        cursor = conn.cursor()
        cursor.execute('''
            INSERT INTO bets (
                match_name, selection, market_type, handicap, 
                danske_odds, fair_odds, ev_percent, stake, game_starts_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''', (
            bet.match_name, 
            bet.selection, 
            bet.market_type, 
            bet.handicap, 
            bet.danske_odds, 
            bet.fair_odds, 
            bet.ev_percent, 
            bet.stake,
            bet.commence_time
        ))
        conn.commit()
        conn.close()

        # --- ARM THE SNIPER ---
        if final_time:
            schedule_clv_job(final_time)
        return {"message": "Bet placed successfully"}
    except Exception as e:
        print(f"Error placing bet: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/my-bets")
def get_my_bets():
    conn = sqlite3.connect(DB_NAME)
    # Return dictionary rows instead of tuples
    conn.row_factory = sqlite3.Row 
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM bets ORDER BY timestamp DESC")
    rows = cursor.fetchall()
    conn.close()
    return {"data": [dict(row) for row in rows]}

@app.post("/api/settle-bets")
def settle_bets():
    conn = sqlite3.connect(DB_NAME)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    # 1. Get Pending Bets
    cursor.execute("SELECT * FROM bets WHERE status = 'Pending'")
    pending_bets = cursor.fetchall()
    
    if not pending_bets:
        conn.close()
        return {"message": "No pending bets to settle"}

    # 2. Get Scores (Once for all bets)
    scores_data = fetch_nba_scores()
    if not scores_data:
        conn.close()
        return {"message": "Could not fetch scores from API"}

    updated_count = 0
    
    # 3. Loop and Grade
    for bet in pending_bets:
        new_status, result_str = grade_bet(dict(bet), scores_data)
        
        if new_status and new_status != 'Pending':
            cursor.execute(
                "UPDATE bets SET status = ?, result_score = ? WHERE id = ?",
                (new_status, result_str, bet['id'])
            )
            updated_count += 1
            print(f"Settled Bet {bet['id']}: {new_status}")

    conn.commit()
    conn.close()

    # Trigger Paper Settlement too (reuse the scores we already fetched)
    settle_paper_bets(scores_data=scores_data)
    
    return {"message": f"Settled {updated_count} bets", "checked": len(pending_bets)}

@app.get("/api/paper-bets")
def get_paper_bets():
    conn = sqlite3.connect(DB_NAME)
    conn.row_factory = sqlite3.Row 
    cursor = conn.cursor()

    # Use configurable limit (defaults to 5000) so analysis covers more history
    config = load_notification_config()
    try:
        limit = int(config.get("paper_bets_limit", "5000"))
    except (ValueError, TypeError):
        limit = 5000
    # Cap at a sane upper bound to protect the DB from absurd values
    limit = max(100, min(limit, 50000))

    cursor.execute("SELECT * FROM paper_bets ORDER BY timestamp DESC LIMIT ?", (limit,))
    rows = cursor.fetchall()
    conn.close()
    return {"data": [dict(row) for row in rows]}

# ---------------------------------------------------------
# ANALYTICS ENDPOINT
# ---------------------------------------------------------
@app.get("/api/analytics")
def get_analytics():
    conn = sqlite3.connect(DB_NAME)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    # Get only SETTLED bets (ignore Pending)
    cursor.execute("SELECT * FROM bets WHERE status IN ('Won', 'Lost', 'Void') ORDER BY timestamp ASC")
    rows = cursor.fetchall()
    conn.close()

    if not rows:
        return {"stats": None, "chart_data": []}

    # Initialize Metrics
    total_bets = 0
    total_stake = 0
    total_profit = 0
    wins = 0
    
    # CLV Tracking
    clv_sum = 0
    clv_count = 0

    # Chart Data (Running Total)
    chart_data = []
    running_profit = 0

    for row in rows:
        bet = dict(row)
        total_bets += 1
        total_stake += bet['stake']
        
        # Calculate Profit for this specific bet
        bet_profit = 0
        if bet['status'] == 'Won':
            bet_profit = (bet['stake'] * bet['danske_odds']) - bet['stake']
            wins += 1
        elif bet['status'] == 'Lost':
            bet_profit = -bet['stake']
        elif bet['status'] == 'Void':
            bet_profit = 0

        total_profit += bet_profit
        running_profit += bet_profit
        
        # Calculate CLV (if available)
        # Formula: (Taken Odds / Closing Odds) - 1
        if bet['closing_odds'] and bet['closing_odds'] > 0:
            clv_val = (bet['danske_odds'] / bet['closing_odds']) - 1
            clv_sum += clv_val
            clv_count += 1

        # Add point to chart
        # We use a short date format for the X-axis
        date_str = bet['timestamp'].split(' ')[0] # YYYY-MM-DD
        chart_data.append({
            "id": bet['id'],
            "date": date_str,
            "match": bet['match_name'],
            "profit": round(running_profit, 2)
        })

    # Final Calculations
    roi = (total_profit / total_stake * 100) if total_stake > 0 else 0
    win_rate = (wins / total_bets * 100) if total_bets > 0 else 0
    avg_clv = (clv_sum / clv_count * 100) if clv_count > 0 else 0

    return {
        "stats": {
            "total_bets": total_bets,
            "total_profit": round(total_profit, 2),
            "roi": round(roi, 2),
            "win_rate": round(win_rate, 1),
            "avg_clv": round(avg_clv, 2)
        },
        "chart_data": chart_data
    }

# ---------------------------------------------------------
# STRATEGY ANALYSIS ENDPOINT (Phase 0+1: evidence tables)
# Uses ONLY already-collected paper_bets data — no extra API credits.
# ---------------------------------------------------------

@app.get("/api/strategy-analysis")
def get_strategy_analysis(
    dedup: str = "match_selection",
    min_ev: float = 0.0,
    max_ev: float = 1e9,
    min_minutes: float = 0.0,
    max_minutes: float = 100000.0,
    min_odds: float = 1.0,
    max_odds: float = 100.0,
):
    if dedup not in ("none", "match_selection", "game"):
        raise HTTPException(status_code=400, detail="dedup must be none, match_selection or game")
    return build_evidence(
        dedup=dedup,
        min_ev=min_ev,
        max_ev=max_ev,
        min_minutes=min_minutes,
        max_minutes=max_minutes,
        min_odds=min_odds,
        max_odds=max_odds,
    )

@app.get("/api/strategy-model")
def get_strategy_model(
    dedup: str = "match_selection",
    min_ev: float = 0.0,
    max_ev: float = 1e9,
    min_minutes: float = 0.0,
    max_minutes: float = 100000.0,
    min_odds: float = 1.0,
    max_odds: float = 100.0,
):
    if dedup not in ("none", "match_selection", "game"):
        raise HTTPException(status_code=400, detail="dedup must be none, match_selection or game")
    return build_model(
        dedup=dedup,
        min_ev=min_ev,
        max_ev=max_ev,
        min_minutes=min_minutes,
        max_minutes=max_minutes,
        min_odds=min_odds,
        max_odds=max_odds,
    )

@app.get("/api/strategy-sweep")
def get_strategy_sweep(
    dedup: str = "match_selection",
    max_ev: float = 1e9,
    max_hours: float = 1e9,
    min_odds: float = 1.0,
    max_odds: float = 100.0,
):
    if dedup not in ("none", "match_selection", "game"):
        raise HTTPException(status_code=400, detail="dedup must be none, match_selection or game")
    return build_sweep(
        dedup=dedup,
        max_ev=max_ev,
        max_hours=max_hours,
        min_odds=min_odds,
        max_odds=max_odds,
    )

# ---------------------------------------------------------
# NOTIFICATION ENDPOINTS
# ---------------------------------------------------------

@app.get("/api/notification-settings")
def get_notification_settings():
    config = load_notification_config()

    # Fetch recent notification log (last 20 entries)
    try:
        conn = sqlite3.connect(DB_NAME)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM notification_log ORDER BY id DESC LIMIT 20"
        )
        log_rows = cursor.fetchall()
        conn.close()
        recent_log = [dict(row) for row in log_rows]
    except Exception as e:
        print(f"Error fetching notification log: {e}")
        recent_log = []

    return {
        "config": config,
        "recent_log": recent_log
    }


@app.post("/api/notification-settings")
def post_notification_settings(config: NotificationConfig):
    try:
        save_dict = {
            "enabled": "true" if config.enabled else "false",
            "ntfy_topic": config.ntfy_topic.strip(),
            "cooldown_minutes": str(config.cooldown_minutes),
            "paper_bets_limit": str(config.paper_bets_limit),
        }
        save_notification_config(save_dict)
        return {"message": "Settings saved successfully"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/notification-rules")
def get_notification_rules():
    rules = load_notification_rules()
    # Convert market_types from comma string to list for frontend
    for rule in rules:
        rule["market_types"] = [
            m.strip() for m in rule.get("market_types", "").split(",") if m.strip()
        ]
    return {"rules": rules}


@app.post("/api/notification-rules")
def post_notification_rules(rules: list[NotificationRule]):
    try:
        save_list = []
        for rule in rules:
            save_list.append({
                "rule_number": rule.rule_number,
                "name": rule.name,
                "enabled": "true" if rule.enabled else "false",
                "min_ev": rule.min_ev,
                "max_ev": rule.max_ev,
                "min_odds": rule.min_odds,
                "max_odds": rule.max_odds,
                "market_types": ",".join(rule.market_types),
                "min_minutes": rule.min_minutes,
                "max_minutes": rule.max_minutes,
            })
        save_notification_rules(save_list)
        return {"message": "Rules saved successfully"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/test-notification")
def test_notification():
    config = load_notification_config()
    topic = config.get("ntfy_topic", "")

    if not topic:
        raise HTTPException(
            status_code=400,
            detail="No Ntfy topic configured. Please save a topic first."
        )

    send_ntfy_notification(
        title="Test: NBA Scanner",
        message=(
            "NBA Scanner is connected!\n\n"
            "Example Edge:\n"
            "Lakers vs Celtics\n"
            "  Lakers +7.5 (Spread)\n"
            "  Danske: 1.87 | Fair: 1.76 | EV: +4.2%"
        ),
        topic=topic
    )

    return {"message": "Test notification sent"}

@app.post("/api/force-scan")
def force_scan():
    """Temporary endpoint to test the full scan + notify pipeline."""
    run_scheduled_scan()
    return {"message": "Scan complete"}

# ---------------------------------------------------------
# 5. SETTLEMENT LOGIC
# ---------------------------------------------------------


# Team name corrections: maps names from Pinnacle/Danske to official NBA API names
# Add entries here if you encounter "not found" issues during settlement
NBA_TEAM_NAME_MAP = {
    # "Pinnacle/Danske name": "Official NBA API name",
}

def fetch_nba_scores_official(days_back=3):
    """
    Fetches NBA scores using the official NBA API.
    Returns data in the same format as fetch_nba_scores() so grade_bet() needs no changes.
    """
    from nba_api.stats.endpoints import leaguegamefinder
    import time as time_module

    print("🏀 Fetching scores via NBA API...")

    try:
        # 1. Build the list of dates to query (last N days in Eastern Time)
        et_tz = pytz.timezone("America/New_York")
        today_et = datetime.now(et_tz)
        dates_to_check = [
            (today_et - timedelta(days=i)).strftime("%m/%d/%Y")
            for i in range(days_back)
        ]

        all_games = []

        for date_str in dates_to_check:
            print(f"  Querying NBA API for {date_str}...")
            try:
                result = leaguegamefinder.LeagueGameFinder(
                    date_from_nullable=date_str,
                    date_to_nullable=date_str,
                    league_id_nullable="00",  # 00 = NBA
                )
                api_df = result.get_data_frames()[0]
            except Exception as e:
                print(f"  ⚠️ NBA API call failed for {date_str}: {e}")
                time_module.sleep(1)
                continue

            if api_df.empty:
                print(f"  No games found for {date_str}")
                time_module.sleep(1)
                continue

            # 2. Group by GAME_ID to pair home/away teams
            for game_id, group in api_df.groupby("GAME_ID"):
                if len(group) != 2:
                    continue  # Should always be 2 teams, skip if not

                # WL column: 'W' or 'L'
                # MATCHUP column: 'Team A vs. Team B' (home) or 'Team A @ Team B' (away)
                home_row = group[group["MATCHUP"].str.contains("vs.")].iloc[0] if not group[group["MATCHUP"].str.contains("vs.")].empty else None
                away_row = group[group["MATCHUP"].str.contains("@")].iloc[0] if not group[group["MATCHUP"].str.contains("@")].empty else None

                if home_row is None or away_row is None:
                    continue

                # 3. Format to match The Odds API format that grade_bet() expects
                all_games.append({
                    "home_team": str(home_row["TEAM_NAME"]),
                    "away_team": str(away_row["TEAM_NAME"]),
                    "completed": True,  # LeagueGameFinder only returns completed games
                    "scores": [
                        {"name": str(home_row["TEAM_NAME"]), "score": str(int(home_row["PTS"]))},
                        {"name": str(away_row["TEAM_NAME"]), "score": str(int(away_row["PTS"]))},
                    ]
                })

            time_module.sleep(1)  # Respect NBA API rate limit

        print(f"🏀 NBA API returned {len(all_games)} completed games.")
        return all_games

    except Exception as e:
        print(f"❌ NBA API fetch failed entirely: {e}")
        return []


def fetch_nba_scores():
    """
    Fetches NBA scores for settlement.

    Strategy:
    1. Try official NBA API first (free, authoritative, slower)
    2. Fall back to The Odds API if NBA API fails or returns no data
    """
    # 1. Try NBA API first
    scores = fetch_nba_scores_official(days_back=3)
    if scores:
        return scores

    # 2. Fall back to The Odds API
    print("⚠️ NBA API returned no data. Falling back to Odds API...")
    url = "https://api.the-odds-api.com/v4/sports/basketball_nba/scores"
    params = {
        "apiKey": API_KEY,
        "daysFrom": 3,
        "dateFormat": "iso"
    }
    try:
        resp = requests.get(url, params=params)
        resp.raise_for_status()
        print("✅ Fallback to Odds API successful.")
        return resp.json()
    except Exception as e:
        print(f"❌ Odds API fallback also failed: {e}")
        return []
    """Fetches scores for the last 3 days from The Odds API"""
    # Note: 'daysFrom' allows us to look back at completed games
    url = f'https://api.the-odds-api.com/v4/sports/basketball_nba/scores'
    params = {
        'apiKey': API_KEY,
        'daysFrom': 3, # Look back 3 days
        'dateFormat': 'iso'
    }
    try:
        resp = requests.get(url, params=params)
        resp.raise_for_status()
        return resp.json()
    except Exception as e:
        print(f"Error fetching scores: {e}")
        return []

def grade_bet(bet_row, scores_data):
    """
    Returns: (New Status, Score String) or (None, None) if game not found/finished
    """
    bet_match_name = bet_row['match_name'] # e.g. "Houston Rockets vs Phoenix Suns"
    
    # 1. PREPARE API DATA FOR MATCHING
    # We construct strings "Home vs Away" for every game in the API response
    # so we can compare apples to apples.
    api_games_map = {}
    for g in scores_data:
        title = f"{g['home_team']} vs {g['away_team']}"
        api_games_map[title] = g

    # 2. FUZZY MATCH THE FULL TITLE
    # This ensures "Rockets vs Suns" doesn't match "Rockets vs Kings"
    potential_matches = list(api_games_map.keys())
    best_match_title, score = process.extractOne(bet_match_name, potential_matches)
    
    # Use a strict threshold (90) because we expect the names to be very similar
    # since both data sources ultimately come from The Odds API context.
    if score < 90: 
        return None, None 

    game = api_games_map[best_match_title]
    
    if not game['completed']: return None, None # Game exists but isn't over

    # 3. EXTRACT SCORES
    home_score = 0
    away_score = 0
    
    # Some API providers return scores as a list, others as null if cancelled
    if not game.get('scores'): return None, None

    for s in game['scores']:
        if s['name'] == game['home_team']: home_score = int(s['score'])
        elif s['name'] == game['away_team']: away_score = int(s['score'])

    result_str = f"{game['home_team']} {home_score} - {away_score} {game['away_team']}"

    # 4. GRADE THE BET
    selection = bet_row['selection']
    market = bet_row['market_type']
    handicap = bet_row['handicap'] or 0.0
    
    status = "Pending"

    # --- LOGIC ---
    
    # A. MONEYLINE
    if market == 'MoneyLine':
        if selection == game['home_team']:
            status = "Won" if home_score > away_score else "Lost"
        else:
            status = "Won" if away_score > home_score else "Lost"

    # B. SPREAD
    elif market == 'Spread':
        # Logic: If selection is Home, we want (HomeScore + Handicap) > AwayScore
        sel_score = home_score if selection == game['home_team'] else away_score
        opp_score = away_score if selection == game['home_team'] else home_score
        
        final_score_adjusted = sel_score + handicap
        
        if final_score_adjusted > opp_score: status = "Won"
        elif final_score_adjusted < opp_score: status = "Lost"
        else: status = "Void" # Push

    # C. TOTALS
    elif market == 'Total':
        total_points = home_score + away_score
        if "Over" in selection:
            status = "Won" if total_points > handicap else "Lost"
        elif "Under" in selection:
            status = "Won" if total_points < handicap else "Lost"
        
        if total_points == handicap: status = "Void"

    return status, result_str

# To run: uvicorn main:app --reload