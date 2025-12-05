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

# Load environment variables
load_dotenv()
API_KEY = os.getenv("API_KEY")

app = FastAPI()

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
            "home_team": home_team_name,
            "away_team": away_team_name,
            "commence_time": event.get('startTime'),
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
# 2. DATA FETCHING: PINNACLE (Quota Management)
# ---------------------------------------------------------
def fetch_pinnacle_cached():
    global pinnacle_cache, latest_quota
    current_time = time.time()

    # Return cache if fresh
    if pinnacle_cache["data"] and (current_time - pinnacle_cache["last_updated"] < CACHE_DURATION):
        print("Returning Cached Pinnacle Data")
        return pinnacle_cache["data"]


    print("Fetching New Pinnacle Data (Using Quota)...")
    
    SPORT_KEY = 'basketball_nba'
    BOOKMAKERS = 'pinnacle'
    MARKETS = 'h2h,spreads,totals' 
    
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

    for bet in pending_bets:
        # 1. Find the matching Pinnacle Event
        match_name, score = process.extractOne(bet['match_name'].split(" vs ")[0], pinnacle_home_teams)
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
                results.append({
                    "id": f"{d_event['home_team']}-{d_market['type']}-{d_selection}-{d_line}", # Unique key for React
                    "match": f"{d_event['home_team']} vs {d_event['away_team']}",
                    "type": d_market['type'],
                    "selection": d_selection,
                    "line": d_line,
                    "danske_odds": d_odds,
                    "fair_odds": round(1/fair_prob, 2) if fair_prob > 0 else 0,
                    "ev": round(ev_percent * 100, 2)
                })

    return sorted(results, key=lambda x: x['ev'], reverse=True)


# ---------------------------------------------------------
# 4. DATABASE SETUP (SQLite)
# ---------------------------------------------------------
DB_NAME = "bets.db"

def init_db():
    conn = sqlite3.connect(DB_NAME)
    cursor = conn.cursor()
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
            closing_odds REAL,  -- NEW: To track CLV
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    conn.commit()
    conn.close()

# Run this on startup
init_db()

class BetRequest(BaseModel):
    match_name: str
    selection: str
    market_type: str
    handicap: Optional[float] = None
    danske_odds: float
    fair_odds: float
    ev_percent: float
    stake: float

# ---------------------------------------------------------
# 5. API ENDPOINT
# ---------------------------------------------------------
@app.get("/api/opportunities")
def get_opportunities():
    if not API_KEY:
        raise HTTPException(status_code=500, detail="API_KEY not set in .env file")

    # 1. Get Data
    danske_data = fetch_danske_spil()
    pinnacle_data = fetch_pinnacle_cached()
    
    # 2. Run Analysis
    if not danske_data or not pinnacle_data:
        return {"message": "Could not fetch data from one or both sources", "data": []}

    # This updates the DB with fresh Pinnacle odds for any pending bets
    update_clv_for_placed_bets(pinnacle_data)

    opportunities = run_analysis(danske_data, pinnacle_data)
    
    return {
        "timestamp": datetime.now().isoformat(),
        "quota_remaining": latest_quota["remaining"], # SEND QUOTA TO FRONTEND
        "count": len(opportunities),
        "data": opportunities
    }

# ---------------------------------------------------------
# BETTING ENDPOINTS
# ---------------------------------------------------------

@app.post("/api/place-bet")
def place_bet(bet: BetRequest):
    try:
        conn = sqlite3.connect(DB_NAME)
        cursor = conn.cursor()
        cursor.execute('''
            INSERT INTO bets (match_name, selection, market_type, handicap, danske_odds, fair_odds, ev_percent, stake)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ''', (
            bet.match_name, 
            bet.selection, 
            bet.market_type, 
            bet.handicap, 
            bet.danske_odds, 
            bet.fair_odds, 
            bet.ev_percent, 
            bet.stake
        ))
        conn.commit()
        conn.close()
        return {"message": "Bet placed successfully"}
    except Exception as e:
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
    
    return {"message": f"Settled {updated_count} bets", "checked": len(pending_bets)}

# ---------------------------------------------------------
# 5. SETTLEMENT LOGIC
# ---------------------------------------------------------
def fetch_nba_scores():
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