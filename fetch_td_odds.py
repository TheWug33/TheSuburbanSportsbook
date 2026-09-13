"""
Fetch anytime-TD odds from The Odds API, attach a stats-based note
computed from real box scores (via nflreadpy — same source as your
props model), and upsert into Supabase `td_odds`.

Env vars required:
  ODDS_API_KEY          - your existing The Odds API key
  SUPABASE_URL          - same Supabase project as nfl-props (or new)
  SUPABASE_SERVICE_KEY  - service_role key (bypasses RLS, needed for writes)
  NFL_WEEK              - current NFL week number, e.g. "3"
  NFL_SEASON            - e.g. "2026"

Run: py -3.12 fetch_td_odds.py

NOTE: this is a starting point, not yet run against a live key. The Odds
API's player-props response shape occasionally shifts, so check the first
run's output against https://the-odds-api.com/liveapi/guides/v4/#get-event-odds
and adjust field names (outcome["description"] vs outcome["name"]) if needed.

The "note" field is generated, not hand-written or scraped: it reports
each player's share of their team's rush attempts + targets over their
last few played games this season. Early in the season (Week 1, or a
player with no games yet) there isn't enough data yet, so the note
falls back to a plain placeholder rather than a fabricated stat.
"""

import os
from datetime import datetime, timezone

import nflreadpy as nfl
import requests
from supabase import create_client

ODDS_API_KEY = os.environ["ODDS_API_KEY"]
SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
WEEK = int(os.environ.get("NFL_WEEK", "1"))
SEASON = int(os.environ.get("NFL_SEASON", "2026"))
LOOKBACK_GAMES = 3

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


def build_touch_share_notes():
    """
    Returns {player_display_name: note_string} using real weekly stats:
    each player's (carries + targets) as a share of their team's total
    over their last LOOKBACK_GAMES played games this season so far.
    """
    weekly = nfl.load_player_stats(seasons=[SEASON])
    played = weekly[weekly["week"] < WEEK]
    if played.empty:
        return {}

    notes = {}
    for team in played["team"].unique():
        team_games = played[played["team"] == team]
        recent_weeks = sorted(team_games["week"].unique())[-LOOKBACK_GAMES:]
        recent = team_games[team_games["week"].isin(recent_weeks)]

        recent = recent.copy()
        recent["touches"] = recent["carries"].fillna(0) + recent["targets"].fillna(0)
        team_touches = recent["touches"].sum()
        if team_touches == 0:
            continue

        by_player = recent.groupby("player_display_name")["touches"].sum()
        for player, touches in by_player.items():
            if touches == 0:
                continue
            share = round(100 * touches / team_touches)
            n_games = len(recent_weeks)
            notes[player] = (
                f"{share}% share of {team}'s touches over last {n_games} game"
                f"{'s' if n_games != 1 else ''}"
            )
    return notes


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
                    if player not in best_by_player or price > best_by_player[player]["price"]:
                        best_by_player[player] = {
                            "price": price,
                            "matchup": f"{away} @ {home}",
                        }

    notes = build_touch_share_notes()

    payload = [
        {
            "week": WEEK,
            "player": player,
            "team": None,
            "opp": info["matchup"],
            "odds": f"{info['price']:+d}",
            "note": notes.get(player, "Not enough recent data yet"),
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

