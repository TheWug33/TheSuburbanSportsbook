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

# Full team name (as The Odds API returns it) -> standard abbreviation
# (matches nflreadpy's team codes for joining against weekly stats).
# NOTE: unverified against a live nflreadpy pull — if a code here
# doesn't match nflreadpy's own team column, that team's notes/matchup
# will just fall back gracefully rather than crash (see try/except below).
TEAM_ABBR = {
    "Arizona Cardinals": "ARI", "Atlanta Falcons": "ATL", "Baltimore Ravens": "BAL",
    "Buffalo Bills": "BUF", "Carolina Panthers": "CAR", "Chicago Bears": "CHI",
    "Cincinnati Bengals": "CIN", "Cleveland Browns": "CLE", "Dallas Cowboys": "DAL",
    "Denver Broncos": "DEN", "Detroit Lions": "DET", "Green Bay Packers": "GB",
    "Houston Texans": "HOU", "Indianapolis Colts": "IND", "Jacksonville Jaguars": "JAX",
    "Kansas City Chiefs": "KC", "Las Vegas Raiders": "LV", "Los Angeles Chargers": "LAC",
    "Los Angeles Rams": "LAR", "Miami Dolphins": "MIA", "Minnesota Vikings": "MIN",
    "New England Patriots": "NE", "New Orleans Saints": "NO", "New York Giants": "NYG",
    "New York Jets": "NYJ", "Philadelphia Eagles": "PHI", "Pittsburgh Steelers": "PIT",
    "San Francisco 49ers": "SF", "Seattle Seahawks": "SEA", "Tampa Bay Buccaneers": "TB",
    "Tennessee Titans": "TEN", "Washington Commanders": "WAS",
}

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


def build_notes():
    """
    Returns {player_display_name: note_string} combining two real signals
    from weekly stats already played this season:
      1. The player's share of their team's touches (carries + targets)
         over their last LOOKBACK_GAMES games.
      2. How many TDs the opponent they're about to face has allowed
         so far this season, framed as a league rank (1 = worst defense
         against scoring = best matchup).

    Wrapped defensively: nflreadpy/polars internals occasionally raise
    version-mismatch errors depending on what's installed, and the
    schedule join depends on TEAM_ABBR matching nflreadpy's own codes.
    If anything here fails, we skip real notes for this run rather than
    crash the whole odds fetch — the odds themselves are what matters.
    """
    try:
        weekly = nfl.load_player_stats(seasons=[SEASON])
        played = weekly[weekly["week"] < WEEK]
        if played.empty:
            return {}, {}

        # --- touch share per player, last few games ---
        touch_notes = {}
        for team in played["team"].unique():
            team_games = played[played["team"] == team]
            recent_weeks = sorted(team_games["week"].unique())[-LOOKBACK_GAMES:]
            recent = team_games[team_games["week"].isin(recent_weeks)].copy()
            recent["touches"] = recent["carries"].fillna(0) + recent["targets"].fillna(0)
            team_touches = recent["touches"].sum()
            if team_touches == 0:
                continue
            by_player = recent.groupby("player_display_name")["touches"].sum()
            for player, touches in by_player.items():
                if touches == 0:
                    continue
                share = round(100 * touches / team_touches)
                n = len(recent_weeks)
                touch_notes[player] = f"{share}% share of {team}'s touches (last {n} gm)"

        # --- defensive TDs allowed per team so far, ranked ---
        played = played.copy()
        played["tds_against"] = played["rushing_tds"].fillna(0) + played["receiving_tds"].fillna(0)
        allowed = played.groupby("opponent_team")["tds_against"].sum().sort_values(ascending=False)
        # rank 1 = allows the most TDs = best matchup to attack
        allowed_rank = {team: i + 1 for i, team in enumerate(allowed.index)}
        n_teams = len(allowed_rank)

        # --- this week's schedule, to find each team's opponent ---
        schedule = nfl.load_schedules(seasons=[SEASON])
        week_games = schedule[schedule["week"] == WEEK]
        opponent_of = {}
        for _, g in week_games.iterrows():
            opponent_of[g["home_team"]] = g["away_team"]
            opponent_of[g["away_team"]] = g["home_team"]

        # player's most recent known team (their last played game)
        player_team = (
            played.sort_values("week")
            .groupby("player_display_name")["team"]
            .last()
            .to_dict()
        )

        matchup_notes = {}
        for player, team in player_team.items():
            opp = opponent_of.get(team)
            rank = allowed_rank.get(opp)
            if opp and rank:
                matchup_notes[player] = f"{opp} ranks {rank}/{n_teams} in TDs allowed"

        return touch_notes, matchup_notes
    except Exception as e:
        print(f"Note generation skipped this run (stats library error): {e}")
        return {}, {}


def main():
    events = get_events()
    best_by_player = {}

    for ev in events:
        home, away = ev.get("home_team"), ev.get("away_team")
        home_abbr = TEAM_ABBR.get(home, home)
        away_abbr = TEAM_ABBR.get(away, away)
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
                            "matchup": f"{away_abbr} @ {home_abbr}",
                        }

    touch_notes, matchup_notes = build_notes()

    def combined_note(player):
        parts = [p for p in (touch_notes.get(player), matchup_notes.get(player)) if p]
        return "; ".join(parts) if parts else "Not enough recent data yet"

    payload = [
        {
            "week": WEEK,
            "player": player,
            "team": None,
            "opp": info["matchup"],
            "odds": f"{info['price']:+d}",
            "note": combined_note(player),
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

