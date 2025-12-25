import tls_client
import json
from datetime import datetime, timedelta

# ---------------------------------------------------------
# 1. HELPER FUNCTIONS (From your existing code)
# ---------------------------------------------------------
def extract_decimal(price_data):
    val = price_data.get('decimal')
    if isinstance(val, dict):
        return float(val.get('parsedValue'))
    return float(val)

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

# ---------------------------------------------------------
# 2. THE NEW FETCH LOGIC (To Test)
# ---------------------------------------------------------
def test_fetch_danske_robust():
    print("\n--- STARTING TEST ---")
    
    session = tls_client.Session(
        client_identifier="chrome_120",
        random_tls_extension_order=True
    )

    # CHANGE 1: Window is now 3 days (72 hours) instead of 1 day
    now = datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')
    future = (datetime.utcnow() + timedelta(days=3)).strftime('%Y-%m-%dT%H:%M:%SZ')
    
    league_id = "18608" # NBA
    
    # CHANGE 2: Added more specific parameters to match browser behavior
    url = (
        f"https://content.sb.danskespil.dk/content-service/api/v1/q/event-list?"
        f"startTimeFrom={now}&startTimeTo={future}"
        f"&maxEvents=100"
        f"&drilldownTagIds={league_id}"
        f"&includeChildMarkets=true"
        f"&prioritisePrimaryMarkets=true"
        f"&eventSortsIncluded=MTCH"       # Ensures we get Matches, not outrights
        f"&excludeEventsWithNoMarkets=false"
        f"&lang=da-DK"                     # Ensures correct formatting
    )

    headers = {
        "authority": "content.sb.danskespil.dk",
        "accept": "application/json",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }

    print(f"Checking URL: {url}")
    print(f"Time Window: {now} to {future}")

    try:
        response = session.get(url, headers=headers)
        print(f"HTTP Status: {response.status_code}")
        
        data = response.json()
        
        # Parse the data
        events = parse_danske_spil(data)
        
        print(f"\n✅ SUCCESS: Found {len(events)} events.\n")
        
        # Print a summary of what we found
        for i, event in enumerate(events):
            print(f"{i+1}. {event['home_team']} vs {event['away_team']}")
            print(f"   Time: {event['commence_time']}")
            print(f"   Markets Found: {len(event['markets'])}")
            
            # Print first 2 markets as sample
            if event['markets']:
                print(f"   Sample Market: {event['markets'][0]['type']} -> {event['markets'][0]['selection']} @ {event['markets'][0]['odds']}")
            print("-" * 40)

    except Exception as e:
        print(f"❌ ERROR: {e}")

if __name__ == "__main__":
    test_fetch_danske_robust()