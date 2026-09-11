import { useEffect, useState } from "react";
import { parseUnits } from "viem";
import { useApp } from "../App";
import { fetchLobbies, tx, LobbyState, type Lobby } from "../contract";
import { fmtUsd } from "../chain";

const stateLabel = (s: LobbyState) => (s === LobbyState.Open ? "open" : s === LobbyState.Live ? "live" : s === LobbyState.Finished ? "finished" : "cancelled");
const stateClass = (s: LobbyState) => (s === LobbyState.Open ? "open" : s === LobbyState.Live ? "live" : "done");

export default function Home() {
  const { wallet, connect, toast } = useApp();
  const [lobbies, setLobbies] = useState<Lobby[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: "", stake: "5", min: "2", max: "16", rounds: "6" });

  const load = () => fetchLobbies().then(setLobbies).catch(() => {});
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const create = async () => {
    if (!wallet) return connect();
    setBusy(true);
    try {
      await tx.createLobby(wallet, form.name || "Arena", parseUnits(form.stake || "1", 6), Number(form.min), Number(form.max), Number(form.rounds));
      toast("Lobby created");
      setForm({ ...form, name: "" });
      await load();
    } catch (e: any) {
      toast(e?.shortMessage || e?.message || String(e), true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="hero">
        <div>
          <h1>
            CALL THE WINDOW.
            <br />
            <em>OUTLAST</em> THE CROWD.
          </h1>
          <p>
            A prediction battle royale on DreamDEX Event Contracts. Everyone stakes into one pot. Every round is a live BTC or ETH window. Call UP or DOWN
            before it locks. The market decides who survives, and the last players standing split the pot.
          </p>
        </div>
        <div className="steps">
          <div className="step">
            <div className="n">01</div>
            <div className="t">Stake and join</div>
            <div className="d">Every player puts the same tUSDC into a shared pot. Lobbies run on 5-minute, 15-minute or 1-hour DreamDEX windows.</div>
          </div>
          <div className="step">
            <div className="n">02</div>
            <div className="t">Call before lock</div>
            <div className="d">The crowd's UP and DOWN stake is minted into real DreamDEX outcome tokens. The surplus hits the live order book.</div>
          </div>
          <div className="step">
            <div className="n">03</div>
            <div className="t">Survive the resolve</div>
            <div className="d">The winning side is read from the DreamDEX market contract itself. Wrong callers are out. Survivors split what the market left.</div>
          </div>
        </div>
      </section>

      <section className="panel" style={{ marginBottom: 18 }}>
        <h3>Open a lobby</h3>
        <div className="form">
          <label>
            name
            <input value={form.name} placeholder="friday arena" onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label>
            stake tUSDC
            <input value={form.stake} onChange={(e) => setForm({ ...form, stake: e.target.value })} />
          </label>
          <label>
            min players
            <input value={form.min} onChange={(e) => setForm({ ...form, min: e.target.value })} />
          </label>
          <label>
            max players
            <input value={form.max} onChange={(e) => setForm({ ...form, max: e.target.value })} />
          </label>
          <label>
            max rounds
            <input value={form.rounds} onChange={(e) => setForm({ ...form, rounds: e.target.value })} />
          </label>
        </div>
        <div className="form-row">
          <button className="btn primary" onClick={create} disabled={busy}>
            {busy ? "Creating…" : wallet ? "Create lobby" : "Connect to create"}
          </button>
        </div>
      </section>

      <section>
        <div className="phase">
          lobbies <span className="bar" />
        </div>
        {lobbies === null ? (
          <div className="notice">Loading lobbies from Somnia…</div>
        ) : lobbies.length === 0 ? (
          <div className="notice">No lobbies yet. Open the first one above.</div>
        ) : (
          <div className="cards">
            {lobbies.map((l) => (
              <a key={l.id} className="card" href={`#/lobby/${l.id}`}>
                <div className="name">
                  <span>
                    #{l.id} {l.name || "Arena"}
                  </span>
                  <span className={`state ${stateClass(l.state)}`}>{stateLabel(l.state)}</span>
                </div>
                <div className="meta">
                  <span>
                    stake <b>{fmtUsd(l.stake)}</b>
                  </span>
                  <span>
                    pot <b>{fmtUsd(l.pot)}</b>
                  </span>
                  <span>
                    alive <b>{l.alive}</b> / {l.maxPlayers}
                  </span>
                  <span>
                    round <b>{l.roundCount}</b> / {l.maxRounds}
                  </span>
                </div>
              </a>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
