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
  { player: "Bijan Robinson", team: "ATL", opp: "CAR", odds: "-142", note: "Bottom-5 run defense, goal-line back" },
  { player: "Ja'Marr Chase", team: "CIN", opp: "MIN", odds: "-125", note: "Target share over 30% last 3 games" },
  { player: "Jonathan Taylor", team: "IND", opp: "TEN", odds: "-118", note: "Heavy volume, soft front seven" },
  { player: "Puka Nacua", team: "LAR", opp: "IND", odds: "+105", note: "Slot matchup vs injured CB2" },
];

const TABS = [
  { id: "enter", label: "Enter Pick" },
  { id: "board", label: "Week Board" },
  { id: "season", label: "Season Grid" },
];

function ResultBadge({ result }) {
  return <span className={`badge badge-${result}`}>{result}</span>;
}

export default function App() {
  const [activeTab, setActiveTab] = useState("enter");
  const [week, setWeek] = useState(1);
  const [picks, setPicks] = useState([]);
  const [weekOdds, setWeekOdds] = useState([]);
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
      .eq("week", w)
      .order("odds", { ascending: true });
    if (err) {
      setError(err.message);
      setWeekOdds(FALLBACK_ODDS);
      return;
    }
    setWeekOdds(data && data.length ? data : FALLBACK_ODDS);
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
            <input
              type="number"
              min="1"
              max={TOTAL_WEEKS}
              value={week}
              onChange={(e) => setWeek(Number(e.target.value) || 1)}
            />
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
                {weekOdds.map((o) => (
                  <option key={o.player} value={o.player} />
                ))}
              </datalist>
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
          <p className="board-caption">Shortest odds to longest — Week {week}</p>
          {weekOdds.length === 0 ? (
            <p className="empty">No odds loaded for this week yet.</p>
          ) : (
            <table className="ledger ledger-board">
              <thead>
                <tr>
                  <th>Player</th>
                  <th>Team</th>
                  <th>Opp</th>
                  <th>Odds</th>
                  <th>Matchup Note</th>
                </tr>
              </thead>
              <tbody>
                {weekOdds.map((o) => (
                  <tr key={o.player}>
                    <td>{o.player}</td>
                    <td>{o.team}</td>
                    <td>{o.opp}</td>
                    <td className="odds-cell">{o.odds}</td>
                    <td className="note-cell">{o.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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
                          {pick ? pick.player.split(" ").slice(-1)[0] : "—"}
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
