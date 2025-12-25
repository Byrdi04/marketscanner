import tls_client
from datetime import datetime, timedelta

def test_connection():
    print("--- DIAGNOSTIC START ---")
    
    # 1. Setup Session (Same as your app)
    session = tls_client.Session(
        client_identifier="chrome_120",
        random_tls_extension_order=True
    )

    # 2. Setup URL
    now = datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')
    future = (datetime.utcnow() + timedelta(days=3)).strftime('%Y-%m-%dT%H:%M:%SZ')
    league_id = "18608" # NBA
    url = f"https://content.sb.danskespil.dk/content-service/api/v1/q/event-list?startTimeFrom={now}&startTimeTo={future}&maxEvents=50&drilldownTagIds={league_id}&includeChildMarkets=true&prioritisePrimaryMarkets=true"

    headers = {
        "authority": "content.sb.danskespil.dk",
        "accept": "application/json",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }

    print(f"Target URL: {url}")

    try:
        response = session.get(url, headers=headers)
        print(f"Status Code: {response.status_code}")
        
        if response.status_code == 200:
            print("Success! First 500 chars of response:")
            print(response.text[:500])
        else:
            print("Failed! Response Headers:")
            print(response.headers)
            print("Response Body:")
            print(response.text[:500])
            
    except Exception as e:
        print(f"CRITICAL ERROR: {e}")

if __name__ == "__main__":
    test_connection()