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
    global pinnacle_cache
    current_time = time.time()

    # CHECK CACHE: If data is fresh (less than 10 mins old), use it.
    if pinnacle_cache["data"] and (current_time - pinnacle_cache["last_updated"] < CACHE_DURATION):
        print("Returning Cached Pinnacle Data (Saving Quota)")
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
    """Creates the table if it doesn't exist"""
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
            status TEXT DEFAULT 'Pending', -- Pending, Won, Lost, Void
            result_score TEXT,             -- e.g. "110-105"
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

    opportunities = run_analysis(danske_data, pinnacle_data)
    
    return {
        "timestamp": datetime.now().isoformat(),
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

# To run: uvicorn main:app --reload