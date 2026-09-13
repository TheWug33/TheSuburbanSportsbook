"""
Auto-grade last week's picks: hit if the player scored a rushing or
receiving TD that week, miss otherwise. Only touches picks still
marked "pending" so it's safe to re-run.

Env vars:
  SUPABASE_URL
  SUPABASE_SERVICE_KEY
  NFL_WEEK     - week to grade, e.g. "3"
  NFL_SEASON   - e.g. "2026"

Run: py -3.12 grade_picks.py

NOTE: column names below (player_display_name, rushing_tds,
receiving_tds) match nflreadpy's load_player_stats as of your
nfl-props ingest. Double check against your existing ingest script
if this errors — column names occasionally shift between releases.
"""

import os
import re

import nflreadpy as nfl
from supabase import create_client

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
WEEK = int(os.environ.get("NFL_WEEK", "1"))
SEASON = int(os.environ.get("NFL_SEASON", "2026"))

supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)


def normalize(name):
    name = name.lower()
    name = re.sub(r"[.\-']", "", name)
    name = re.sub(r"\s+(jr|sr|ii|iii|iv)$", "", name)
    return name.strip()


def get_td_scorers():
    weekly = nfl.load_player_stats(seasons=[SEASON]).to_pandas()
    weekly = weekly[weekly["week"] == WEEK]
    tds = weekly["rushing_tds"].fillna(0) + weekly["receiving_tds"].fillna(0)
    scorers = weekly[tds > 0]["player_display_name"].tolist()
    return {normalize(n) for n in scorers}


def main():
    scorers = get_td_scorers()
    resp = (
        supabase.table("picks")
        .select("*")
        .eq("week", WEEK)
        .eq("result", "pending")
        .execute()
    )
    picks = resp.data or []

    updated = 0
    for p in picks:
        result = "hit" if normalize(p["player"]) in scorers else "miss"
        supabase.table("picks").update({"result": result}).eq("id", p["id"]).execute()
        updated += 1

    print(f"Graded {updated} picks for week {WEEK} ({len(scorers)} players scored a TD)")


if __name__ == "__main__":
    main()
