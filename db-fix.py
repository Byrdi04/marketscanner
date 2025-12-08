import sqlite3
import os

# Path to your database
DB_PATH = os.path.join("backend", "bets.db")

def reset_bets():
    if not os.path.exists(DB_PATH):
        print(f"Error: Could not find database at {DB_PATH}")
        return

    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    # 1. Select the 3 earliest bets
    print("--- Looking for the first 3 bets ---")
    cursor.execute("SELECT id, match_name, selection, status FROM bets ORDER BY id ASC LIMIT 3")
    rows = cursor.fetchall()

    if not rows:
        print("No bets found in database.")
        return

    ids_to_fix = []
    for row in rows:
        print(f"ID: {row[0]} | Match: {row[1]} | Selection: {row[2]} | Current Status: {row[3]}")
        ids_to_fix.append(row[0])

    # 2. Ask for confirmation
    confirm = input("\nDo you want to RESET these bets to 'Pending'? (y/n): ")
    
    if confirm.lower() == 'y':
        # 3. Perform the Update
        # We set status to 'Pending' and clear the bad 'result_score'
        placeholders = ','.join('?' * len(ids_to_fix))
        query = f"UPDATE bets SET status = 'Pending', result_score = NULL WHERE id IN ({placeholders})"
        
        cursor.execute(query, ids_to_fix)
        conn.commit()
        print(f"\nSuccess! {cursor.rowcount} bets reset.")
        print("Now go to your Portfolio Page and click 'Update Results' to re-grade them with the fixed logic.")
    else:
        print("Operation cancelled.")

    conn.close()

if __name__ == "__main__":
    reset_bets()