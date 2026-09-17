import { useState, useEffect, useMemo, useCallback } from "react";
import { supabase } from "./supabaseClient";
import "./App.css";

/*
  THE SUBURBAN SPORTSBOOK
  ------------------------
  Weekly anytime-TD pick tracker for the 5-person pool.

  Reads/writes two Supabase tables (see schema.sql):
    - td_odds(week, player, team, opp, odds, note)   <- filled by fetch_td_odds.py
    - picks(week, person, player, result)            <- filled by this app

  If VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY aren't set yet, the app
  still runs on the FALLBACK_ODDS below so you can preview it before the
  backend is wired up.
*/

const PEOPLE = ["Wug", "The Beef", "Baby", "Donovan", "Big Daddy"];
const TOTAL_WEEKS = 18;

const FALLBACK_ODDS = [
  { player: "Christian McCaffrey", team: "SF", opp: "LAR", odds: "-142", note: "Shanahan's offense funnels goal-line work through him" },
  { player: "Derrick Henry", team: "BAL", opp: "IND", odds: "-130", note: "Ravens lean on him inside the 10-yard line" },
  { player: "Jonathan Taylor", team: "IND", opp: "BAL", odds: "-120", note: "Workhorse volume against a middling Ravens front seven" },
  { player: "Ja'Marr Chase", team: "CIN", opp: "TB", odds: "-118", note: "Bengals' clear top red-zone target when Burrow's under center" },
  { player: "Saquon Barkley", team: "PHI", opp: "WAS", odds: "-110", note: "Tush-push package makes him an automatic look near the goal line" },
  { player: "Josh Jacobs", team: "GB", opp: "MIN", odds: "-105", note: "Packers' clear early-down and short-yardage back" },
  { player: "Kyren Williams", team: "LAR", opp: "SF", odds: "+100", note: "Rams still funnel goal-line carries to him over the passing game" },
  { player: "Bucky Irving", team: "TB", opp: "CIN", odds: "+105", note: "Buccaneers' lead back in a game that could turn into a shootout" },
  { player: "Breece Hall", team: "NYJ", opp: "TEN", odds: "+110", note: "Featured role in a spot Jets should control on the ground" },
  { player: "Justin Jefferson", team: "MIN", opp: "GB", odds: "+115", note: "Vikings' clearest red-zone target at receiver" },
  { player: "De'Von Achane", team: "MIA", opp: "LV", odds: "+120", note: "Dolphins' top pass-catching threat near the end zone" },
  { player: "Brock Bowers", team: "LV", opp: "MIA", odds: "+125", note: "Raiders' most-targeted red-zone weapon at tight end" },
  { player: "CeeDee Lamb", team: "DAL", opp: "NYG", odds: "+130", note: "Cowboys' No. 1 option against a rebuilding Giants secondary" },
  { player: "Jahmyr Gibbs", team: "DET", opp: "NO", odds: "+135", note: "Shares touches but scores efficiently in short yardage" },
  { player: "James Cook", team: "BUF", opp: "HOU", odds: "+140", note: "Bills' clear goal-line back" },
  { player: "Travis Kelce", team: "KC", opp: "DEN", odds: "+145", note: "Still Kansas City's security blanket near the end zone" },
  { player: "Chuba Hubbard", team: "CAR", opp: "CHI", odds: "+150", note: "Panthers' lead back in a get-right spot vs a rebuilding front" },
  { player: "Malik Nabers", team: "NYG", opp: "DAL", odds: "+160", note: "Giants' clear top target, expected high-volume role" },
];

const TABS = [
  { id: "enter", label: "Enter Pick" },
  { id: "board", label: "Week Board" },
  { id: "season", label: "Season Grid" },
];

const BOARD_LIMIT = 15;

function normalizeOdds(rows) {
  // DB rows already store a descriptive matchup string in `opp`
  // (e.g. "Buffalo Bills @ Houston Texans"). Fallback rows instead
  // have separate team/opp fields — combine those into the same shape.
  const normalized = rows.map((o) => ({
    player: o.player,
    matchup: o.team ? `${o.team} vs ${o.opp}` : o.opp,
    odds: o.odds,
    note: o.manual_note || o.note,
  }));
  normalized.sort((a, b) => parseInt(a.odds, 10) - parseInt(b.odds, 10));
  return normalized.slice(0, BOARD_LIMIT);
}

function ResultBadge({ result }) {
  return <span className={`badge badge-${result}`}>{result}</span>;
}

export default function App() {
  const [activeTab, setActiveTab] = useState("enter");
  const [week, setWeek] = useState(1);
  const [picks, setPicks] = useState([]);
  const [weekOdds, setWeekOdds] = useState([]);
  const [allPlayerNames, setAllPlayerNames] = useState([]);
  const [name, setName] = useState(PEOPLE[0]);
  const [player, setPlayer] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const loadPicks = useCallback(async () => {
    const { data, error: err } = await supabase.from("picks").select("*");
    if (err) {
      setError(err.message);
      return;
    }
    setPicks(data || []);
  }, []);

  const loadWeekOdds = useCallback(async (w) => {
    const { data, error: err } = await supabase
      .from("td_odds")
      .select("*")
      .eq("week", w);
    if (err) {
      setError(err.message);
      setWeekOdds(normalizeOdds(FALLBACK_ODDS));
      setAllPlayerNames(FALLBACK_ODDS.map((o) => o.player));
      return;
    }
    const rows = data && data.length ? data : FALLBACK_ODDS;
    setWeekOdds(normalizeOdds(rows));
    setAllPlayerNames([...new Set(rows.map((o) => o.player))].sort());
  }, []);

  useEffect(() => {
    setLoading(true);
    Promise.all([loadPicks(), loadWeekOdds(week)]).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [week]);

  const thisWeekPicks = picks.filter((p) => p.week === week);
  const alreadyPicked = thisWeekPicks.find((p) => p.person === name);

  const standings = useMemo(() => {
    const tally = {};
    PEOPLE.forEach((p) => (tally[p] = { hits: 0, total: 0 }));
    picks.forEach((p) => {
      if (!tally[p.person]) tally[p.person] = { hits: 0, total: 0 };
      tally[p.person].total += 1;
      if (p.result === "hit") tally[p.person].hits += 1;
    });
    return Object.entries(tally).sort((a, b) => b[1].hits - a[1].hits);
  }, [picks]);

  const weekNumbers = Array.from({ length: TOTAL_WEEKS }, (_, i) => i + 1);

  async function submitPick(e) {
    e.preventDefault();
    if (!player.trim()) return;
    const { error: err } = await supabase
      .from("picks")
      .upsert(
        { week, person: name, player: player.trim(), result: "pending" },
        { onConflict: "week,person" }
      );
    if (err) {
      setError(err.message);
      return;
    }
    setPlayer("");
    loadPicks();
  }

  async function clearPick() {
    const { error: err } = await supabase
      .from("picks")
      .delete()
      .eq("week", week)
      .eq("person", name);
    if (err) {
      setError(err.message);
      return;
    }
    setPlayer("");
    loadPicks();
  }

  return (
    <div className="page">
      <header className="masthead">
        <div className="masthead-row">
          <h1>The Suburban Sportsbook</h1>
          <label className="week-select">
            Week
            <select
              value={week}
              onChange={(e) => setWeek(Number(e.target.value))}
            >
              {weekNumbers.map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="masthead-sub">Five picks, one week, anytime TD or bust.</p>
      </header>

      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={activeTab === t.id ? "tab tab-active" : "tab"}
            onClick={() => setActiveTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {error && <p className="error-note">{error} — showing fallback data.</p>}

      {activeTab === "enter" && (
        <section className="slip">
          <div className="slip-stub">
            <span>Week {week}</span>
            <span>Anytime TD Pick</span>
          </div>
          <div className="slip-perf" aria-hidden="true" />
          <form className="slip-body" onSubmit={submitPick}>
            <label>
              Name
              <select value={name} onChange={(e) => setName(e.target.value)}>
                {PEOPLE.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Player
              <input
                list="player-suggestions"
                value={player}
                onChange={(e) => setPlayer(e.target.value)}
                placeholder="Start typing a player..."
              />
              <datalist id="player-suggestions">
                {allPlayerNames.map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
              {player.trim() &&
                !allPlayerNames.some(
                  (p) => p.toLowerCase() === player.trim().toLowerCase()
                ) && (
                  <p className="typo-warning">
                    Not an exact match to a listed player — check spelling so it grades correctly
                  </p>
                )}
            </label>
            <div className="slip-buttons">
              <button type="submit" className="lock-btn" disabled={loading}>
                {alreadyPicked ? "Change Pick" : "Lock In Pick"}
              </button>
              {alreadyPicked && (
                <button
                  type="button"
                  className="clear-btn"
                  onClick={clearPick}
                  disabled={loading}
                >
                  Clear Pick
                </button>
              )}
            </div>
            {alreadyPicked && (
              <p className="slip-note">Currently locked: {alreadyPicked.player}</p>
            )}
          </form>

          {thisWeekPicks.length > 0 && (
            <table className="ledger">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Player</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {thisWeekPicks.map((p) => (
                  <tr key={p.person}>
                    <td>{p.person}</td>
                    <td>{p.player}</td>
                    <td>
                      <ResultBadge result={p.result} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {activeTab === "board" && (
        <section className="board">
          <p className="board-caption">
            Top {BOARD_LIMIT}, shortest odds to longest — Week {week}
          </p>
          {weekOdds.length === 0 ? (
            <p className="empty">No odds loaded for this week yet.</p>
          ) : (
            <div className="board-list">
              {weekOdds.map((o) => (
                <div className="board-row" key={o.player}>
                  <div className="board-row-top">
                    <span className="board-player">{o.player}</span>
                    <span className="odds-cell">{o.odds}</span>
                  </div>
                  <div className="board-matchup">{o.matchup}</div>
                  <div className="board-note">{o.note}</div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {activeTab === "season" && (
        <section className="log">
          <table className="standings">
            <thead>
              <tr>
                <th>Name</th>
                <th>Hits</th>
                <th>Picks</th>
              </tr>
            </thead>
            <tbody>
              {standings.map(([person, s]) => (
                <tr key={person}>
                  <td>{person}</td>
                  <td>{s.hits}</td>
                  <td>{s.total}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="grid-scroll">
            <table className="season-grid">
              <thead>
                <tr>
                  <th className="corner">Week</th>
                  {weekNumbers.map((w) => (
                    <th key={w}>{w}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {PEOPLE.map((person) => (
                  <tr key={person}>
                    <td className="row-label">{person}</td>
                    {weekNumbers.map((w) => {
                      const pick = picks.find(
                        (p) => p.week === w && p.person === person
                      );
                      return (
                        <td
                          key={w}
                          className={`grid-cell ${pick ? `grid-${pick.result}` : ""}`}
                          title={pick ? pick.player : "No pick"}
                        >
                          {pick ? pick.player : "—"}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
