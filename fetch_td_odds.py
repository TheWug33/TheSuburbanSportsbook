"""
Fetch anytime-TD odds from The Odds API and upsert into Supabase `td_odds`.

Env vars required:
  ODDS_API_KEY          - your existing The Odds API key
  SUPABASE_URL          - same Supabase project as nfl-props (or new)
  SUPABASE_SERVICE_KEY  - service_role key (bypasses RLS, needed for writes)
  NFL_WEEK              - current NFL week number, e.g. "3"

Run: py -3.12 fetch_td_odds.py

NOTE: this is a starting point, not yet run against a live key. The Odds
API's player-props response shape occasionally shifts, so check the first
run's output against https://the-odds-api.com/liveapi/guides/v4/#get-event-odds
and adjust field names (outcome["description"] vs outcome["name"]) if needed.
"""

import os
from datetime import datetime, timezone

import requests
from supabase import create_client

ODDS_API_KEY = os.environ["ODDS_API_KEY"]
SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
WEEK = int(os.environ.get("NFL_WEEK", "1"))

SPORT = "americanfootball_nfl"
MARKET = "player_anytime_td"
REGION = "us"

supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)


def get_events():
    url = f"https://api.the-odds-api.com/v4/sports/{SPORT}/events"
    resp = requests.get(url, params={"apiKey": ODDS_API_KEY})
    resp.raise_for_status()
    return resp.json()


def get_event_td_odds(event_id):
    url = f"https://api.the-odds-api.com/v4/sports/{SPORT}/events/{event_id}/odds"
    params = {
        "apiKey": ODDS_API_KEY,
        "regions": REGION,
        "markets": MARKET,
        "oddsFormat": "american",
    }
    resp = requests.get(url, params=params)
    resp.raise_for_status()
    return resp.json()


def main():
    events = get_events()
    best_by_player = {}

    for ev in events:
        home, away = ev.get("home_team"), ev.get("away_team")
        try:
            data = get_event_td_odds(ev["id"])
        except requests.HTTPError as e:
            print(f"Skipping {away} @ {home}: {e}")
            continue

        for book in data.get("bookmakers", []):
            for market in book.get("markets", []):
                if market["key"] != MARKET:
                    continue
                for outcome in market["outcomes"]:
                    player = outcome.get("description") or outcome.get("name")
                    price = outcome.get("price")
                    if player is None or price is None:
                        continue
                    # Keep the best (highest) price offered across books
                    if player not in best_by_player or price > best_by_player[player]["price"]:
                        best_by_player[player] = {
                            "price": price,
                            "matchup": f"{away} @ {home}",
                        }

    payload = [
        {
            "week": WEEK,
            "player": player,
            "team": None,  # fill in manually or extend script to map roster->team
            "opp": info["matchup"],
            "odds": f"{info['price']:+d}",
            "note": None,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        for player, info in best_by_player.items()
    ]

    if not payload:
        print("No TD odds returned — check API key / week / market availability.")
        return

    supabase.table("td_odds").upsert(payload, on_conflict="week,player").execute()
    print(f"Upserted {len(payload)} TD odds rows for week {WEEK}")


if __name__ == "__main__":
    main()
