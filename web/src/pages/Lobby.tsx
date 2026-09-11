import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../App";
import {
  fetchLobby,
  fetchRounds,
  fetchPlayers,
  fetchFeed,
  fetchLiveMarkets,
  marketTerminal,
  allowance,
  tx,
  Side,
  LobbyState,
  RoundState,
  type Lobby,
  type Round,
  type PlayerState,
  type FeedItem,
  type LiveMarket,
} from "../contract";
import { addrUrl, txUrl, short, fmtUsd, fmtQty, clock, mmss } from "../chain";

const MIN_LEAD = 150;
const sideName = (s: Side) => (s === Side.Up ? "UP" : s === Side.Down ? "DOWN" : "—");
const seriesName = (r: Round | LiveMarket | null, asset?: string) =>
  r && "intervalSec" in r ? `${r.asset} ${r.intervalSec / 60}m` : asset ? asset : "window";

export default function LobbyPage({ id }: { id: number }) {
  const { wallet, connect, toast, refreshBalance } = useApp();
  const [lobby, setLobby] = useState<Lobby | null>(null);
  const [rounds, setRounds] = useState<Round[]>([]);
  const [players, setPlayers] = useState<PlayerState[]>([]);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [markets, setMarkets] = useState<LiveMarket[]>([]);
  const [terminal, setTerminal] = useState<{ resolved: boolean; voided: boolean } | null>(null);
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));
  const [busy, setBusy] = useState<string | null>(null);
  const [hasAllowance, setHasAllowance] = useState<boolean | null>(null);
  const feedHead = useRef<bigint | null>(null);

  // clock
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 500);
    return () => clearInterval(t);
  }, []);

  // state polling
  const load = useCallback(async () => {
    try {
      const [l, rs, ps] = await Promise.all([fetchLobby(id), fetchRounds(id), fetchPlayers(id)]);
      setLobby(l);
      setRounds(rs);
      setPlayers(ps);
      const cur = rs[rs.length - 1];
      if (cur && cur.state !== RoundState.Finalized && now >= cur.expiry - 5) {
        marketTerminal(cur.market).then(setTerminal).catch(() => {});
      } else {
        setTerminal(null);
      }
      // feed: full history on first load (from the lobby's creation block), then incremental
      const from = feedHead.current === null ? l.createdBlock : feedHead.current + 1n;
      const { items, head } = await fetchFeed(id, from);
      if (items.length) {
        // keep the updater pure: dedupe by key inside it, no refs mutated
        setFeed((f) => {
          const keys = new Set(f.map((i) => i.key));
          const fresh = items.filter((i) => !keys.has(i.key));
          return fresh.length ? [...f, ...fresh].sort((a, b) => (a.block === b.block ? 0 : a.block < b.block ? -1 : 1)) : f;
        });
      }
      feedHead.current = head;
    } catch (e) {
      console.warn("lobby load failed", e);
    }
  }, [id, now]);

  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    const go = () => fetchLiveMarkets().then(setMarkets).catch(() => {});
    go();
    const t = setInterval(go, 20000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!wallet) return setHasAllowance(null);
    allowance(wallet.address)
      .then((a) => setHasAllowance(a > 10n ** 12n))
      .catch(() => {});
  }, [wallet, busy]);

  const cur = rounds[rounds.length - 1] || null;
  const me = wallet ? players.find((p) => p.address.toLowerCase() === wallet.address.toLowerCase()) : undefined;
  const upPct = cur && cur.upCount + cur.downCount > 0 ? Math.round((100 * cur.upCount) / (cur.upCount + cur.downCount)) : 50;

  const nextMarket = useMemo(() => markets.find((m) => m.expiry >= now + MIN_LEAD + 15) || null, [markets, now]);
  const curSeries = useMemo(() => {
    if (!cur) return null;
    const m = markets.find((x) => x.marketId.toLowerCase() === cur.marketId.toLowerCase());
    return m ? `${m.asset} ${m.intervalSec / 60}m` : null;
  }, [cur, markets]);

  const run = async (label: string, fn: () => Promise<unknown>, ok?: string) => {
    if (!wallet) return connect();
    setBusy(label);
    try {
      await fn();
      if (ok) toast(ok);
      await load();
      refreshBalance();
    } catch (e: any) {
      const msg = e?.shortMessage || e?.message || String(e);
      toast(msg.split("\n")[0].slice(0, 180), true);
    } finally {
      setBusy(null);
    }
  };

  if (!lobby) return <div className="notice">Loading lobby #{id} from Somnia…</div>;

  // ---- phase ----
  let phase = "";
  let countdown: number | null = null;
  let hot = false;
  if (lobby.state === LobbyState.Open) phase = `waiting for players · ${players.length}/${lobby.minPlayers} needed`;
  else if (lobby.state === LobbyState.Finished) phase = "finished";
  else if (lobby.state === LobbyState.Cancelled) phase = "cancelled";
  else if (cur) {
    if (cur.state === RoundState.Calling && now < cur.callDeadline) {
      phase = `round ${cur.index} · calls open`;
      countdown = cur.callDeadline - now;
      hot = countdown <= 15;
    } else if (cur.state === RoundState.Calling && now < cur.expiry) {
      phase = `round ${cur.index} · locking in`;
      countdown = cur.expiry - now;
    } else if (cur.state === RoundState.Executed && now < cur.expiry) {
      phase = `round ${cur.index} · locked · window closing`;
      countdown = cur.expiry - now;
    } else if (cur.state !== RoundState.Finalized) {
      phase = `round ${cur.index} · waiting for DreamDEX to resolve`;
    } else {
      phase = `round ${cur.index} settled · next round starting`;
    }
  }

  const canCall = wallet && me?.alive && cur && cur.state === RoundState.Calling && now < cur.callDeadline && lobby.state === LobbyState.Live;
  const canExecute = cur && cur.state === RoundState.Calling && now >= cur.callDeadline && now < cur.expiry - 15;
  const canFinalize = cur && cur.state !== RoundState.Finalized && now >= cur.expiry && terminal && (terminal.resolved || terminal.voided);
  const canStart =
    (lobby.state === LobbyState.Open && players.length >= lobby.minPlayers) ||
    (lobby.state === LobbyState.Live && (!cur || cur.state === RoundState.Finalized) && lobby.roundCount < lobby.maxRounds);

  return (
    <div className="grid2">
      <div className="stack">
        <div className="panel">
          <div className="phase">
            {phase} <span className="bar" />
            <span style={{ color: "var(--muted)" }}>lobby #{lobby.id}</span>
          </div>
          <div className="hud">
            <div className="stat">
              <div className="k">pot</div>
              <div className="v neon">{fmtUsd(lobby.pot)}</div>
              <div className="s">tUSDC · stake {fmtUsd(lobby.stake)}</div>
            </div>
            <div className="stat">
              <div className="k">alive</div>
              <div className="v">
                {lobby.alive}
                <span style={{ color: "var(--dim)", fontSize: 22 }}> / {players.length}</span>
              </div>
              <div className="s">{Math.max(0, players.length - lobby.alive)} eliminated</div>
            </div>
            <div className="stat">
              <div className="k">round</div>
              <div className="v">
                {lobby.roundCount}
                <span style={{ color: "var(--dim)", fontSize: 22 }}> / {lobby.maxRounds}</span>
              </div>
              <div className="s">{curSeries || (cur ? "DreamDEX window" : "not started")}</div>
            </div>
            <div className="stat">
              <div className="k">{countdown !== null ? (cur?.state === RoundState.Calling && now < (cur?.callDeadline || 0) ? "calls lock in" : "window closes in") : "clock"}</div>
              <div className={`v ${countdown !== null ? "" : "small"} ${hot ? "hot" : ""}`}>{countdown !== null ? mmss(countdown) : clock(now).slice(0, 8)}</div>
              <div className="s">{cur ? `closes ${clock(cur.expiry)}` : "UTC"}</div>
            </div>
          </div>

          <div className="spacer" />

          {lobby.state === LobbyState.Live && cur && (
            <>
              <div className="callbox">
                <button
                  className={`callbtn up ${me?.call === Side.Up ? "active" : ""}`}
                  disabled={!canCall || busy !== null}
                  onClick={() => run("up", () => tx.call(wallet!, id, Side.Up), "Called UP")}
                >
                  ▲ UP
                  <small>{cur.upCount} calls</small>
                </button>
                <button
                  className={`callbtn down ${me?.call === Side.Down ? "active" : ""}`}
                  disabled={!canCall || busy !== null}
                  onClick={() => run("down", () => tx.call(wallet!, id, Side.Down), "Called DOWN")}
                >
                  ▼ DOWN
                  <small>{cur.downCount} calls</small>
                </button>
              </div>
              <div className="crowd">
                <div className="lbl">
                  <span>crowd · {upPct}% up</span>
                  <span>{100 - upPct}% down</span>
                </div>
                <div className="track">
                  <div className="up" style={{ width: `${cur.upCount + cur.downCount ? (100 * cur.upCount) / (cur.upCount + cur.downCount) : 0}%` }} />
                  <div className="down" style={{ width: `${cur.upCount + cur.downCount ? (100 * cur.downCount) / (cur.upCount + cur.downCount) : 0}%` }} />
                </div>
              </div>
              <div className="spacer" />
              {!wallet && <div className="notice">Spectating. Connect a wallet to play.</div>}
              {wallet && !me && <div className="notice">You are not in this lobby. It is already live.</div>}
              {me && !me.alive && (
                <div className="notice out">
                  You were eliminated in round {me.outRound}. Stay and watch the rest fall.
                </div>
              )}
              {me?.alive && cur.state === RoundState.Calling && now < cur.callDeadline && (
                <div className={`notice ${me.call ? "neon" : ""}`}>
                  {me.call ? `Your call is ${sideName(me.call)}. You can change it until the lock.` : "No call yet. Silence is elimination."}
                </div>
              )}
              {cur.state === RoundState.Executed && (
                <div className="notice neon">
                  Locked. {fmtQty(cur.setsMinted)} complete sets minted on DreamDEX{cur.bookFilled > 0n ? `, ${fmtQty(cur.bookFilled)} ${sideName(cur.bookSide)} contracts taken from the book` : ""}.
                  {" "}{fmtUsd(cur.spent)} tUSDC in play. Waiting for the window to close and the oracle to resolve.
                </div>
              )}
              {cur.state === RoundState.Finalized && (
                <div className={`notice ${cur.voided ? "" : "win"}`}>
                  Round {cur.index}: {cur.voided ? "window voided by DreamDEX, nobody falls" : `market went ${sideName(cur.winner)} · ${cur.eliminated} eliminated · ${fmtUsd(cur.returned)} tUSDC redeemed back to the pot`}.
                </div>
              )}
            </>
          )}

          {lobby.state === LobbyState.Open && (
            <div className="notice">
              {players.length}/{lobby.maxPlayers} players in. The first round starts on the next live {nextMarket ? `${nextMarket.asset} ${nextMarket.intervalSec / 60}m` : ""} window once {lobby.minPlayers} have joined.
            </div>
          )}

          {lobby.state === LobbyState.Finished && (
            <div className="finished">
              <div className="big">{lobby.alive === 1 ? "LAST ONE STANDING" : `${lobby.alive} SURVIVORS`}</div>
              <div className="sub">
                pot {fmtUsd(lobby.pot + BigInt(players.filter((p) => p.alive).length === 0 ? 0 : 0))} tUSDC · {fmtUsd(lobby.payoutPerSurvivor)} each
              </div>
              {me?.alive && (
                <div className="actions" style={{ justifyContent: "center" }}>
                  <button className="btn primary" disabled={busy !== null} onClick={() => run("claim", () => tx.claim(wallet!, id), "Payout claimed")}>
                    Claim {fmtUsd(lobby.payoutPerSurvivor)} tUSDC
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="actions">
            {lobby.state === LobbyState.Open && wallet && !me && (
              <button
                className="btn primary"
                disabled={busy !== null}
                onClick={() =>
                  run(
                    "join",
                    async () => {
                      if (!hasAllowance) await tx.approve(wallet!);
                      await tx.join(wallet!, id);
                    },
                    "You are in"
                  )
                }
              >
                {hasAllowance === false ? "Approve & join" : "Join"} · {fmtUsd(lobby.stake)} tUSDC
              </button>
            )}
            {lobby.state === LobbyState.Open && !wallet && (
              <button className="btn primary" onClick={connect}>
                Connect to join
              </button>
            )}
            {lobby.state === LobbyState.Open && me && (
              <button className="btn ghost" disabled={busy !== null} onClick={() => run("leave", () => tx.leave(wallet!, id), "Left the lobby")}>
                Leave
              </button>
            )}
            {canStart && (
              <button
                className="btn"
                disabled={busy !== null || !nextMarket}
                title={nextMarket ? `Start on ${nextMarket.asset} ${nextMarket.intervalSec / 60}m closing ${clock(nextMarket.expiry)}` : "No eligible live window right now"}
                onClick={() => run("start", () => tx.startRound(wallet!, id, nextMarket!.pool, nextMarket!.marketId), "Round started")}
              >
                {lobby.roundCount === 0 ? "Start game" : "Start next round"}
                {nextMarket ? ` · ${nextMarket.asset} ${nextMarket.intervalSec / 60}m` : ""}
              </button>
            )}
            {canExecute && (
              <button className="btn primary" disabled={busy !== null} onClick={() => run("lock", () => tx.executeRound(wallet!, id), "Round locked on DreamDEX")}>
                Lock in on DreamDEX
              </button>
            )}
            {canFinalize && (
              <button className="btn primary" disabled={busy !== null} onClick={() => run("finalize", () => tx.finalizeRound(wallet!, id), "Round settled")}>
                Settle from market
              </button>
            )}
            {busy && <span className="pill">{busy}…</span>}
          </div>
          <div className="notice" style={{ marginTop: 12, fontSize: 12 }}>
            Lock, settle and start are permissionless. A keeper runs them for you; the buttons appear so anyone can push the game forward if it stalls.
          </div>
        </div>

        <div className="panel">
          <h3>Players</h3>
          <div className="players">
            {players.map((p) => (
              <div
                key={p.address}
                className={`pl ${p.alive ? (p.call === Side.Up ? "up" : p.call === Side.Down ? "down" : "") : "out"} ${
                  wallet && p.address.toLowerCase() === wallet.address.toLowerCase() ? "me" : ""
                }`}
              >
                <a className="a" href={addrUrl(p.address)} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>
                  {short(p.address)}
                </a>
                <span className="c">{p.alive ? (cur && cur.state !== RoundState.Finalized && lobby.state === LobbyState.Live ? sideName(p.call) : "alive") : `out r${p.outRound}`}</span>
              </div>
            ))}
            {players.length === 0 && <div className="muted mono">Nobody yet.</div>}
          </div>
        </div>

        {rounds.length > 0 && (
          <div className="panel">
            <h3>Rounds</h3>
            <div className="rounds">
              {rounds.map((r) => (
                <div className="rd" key={r.index}>
                  <div className="n">{String(r.index).padStart(2, "0")}</div>
                  <div>
                    <div>
                      up {r.upCount} · down {r.downCount} · {fmtQty(r.setsMinted)} sets{r.bookFilled > 0n ? ` · ${fmtQty(r.bookFilled)} from book` : ""} · {fmtUsd(r.spent)} in → {fmtUsd(r.returned)} back
                    </div>
                    <div className="muted">
                      window closes {clock(r.expiry)} · <a href={addrUrl(r.market)} target="_blank" rel="noreferrer">market</a> · <a href={addrUrl(r.pool)} target="_blank" rel="noreferrer">pool</a>
                    </div>
                  </div>
                  <div className={`w ${r.state === RoundState.Finalized ? (r.voided ? "void" : r.winner === Side.Up ? "up" : "down") : ""}`}>
                    {r.state === RoundState.Finalized ? (r.voided ? "VOID" : `${sideName(r.winner)} · ${r.eliminated} out`) : r.state === RoundState.Executed ? "locked" : "calling"}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="stack">
        <div className="panel">
          <h3>Feed</h3>
          <div className="feed">
            {[...feed].reverse().map((e) => (
              <FeedRow key={e.key} e={e} />
            ))}
            {feed.length === 0 && <div className="muted mono">Waiting for the first move.</div>}
          </div>
        </div>
        <div className="panel">
          <h3>On chain</h3>
          <div className="kv">
            <span>arena</span>
            <b>
              <a href={addrUrl(lobby.creator)} target="_blank" rel="noreferrer">
                created by {short(lobby.creator)}
              </a>
            </b>
            {cur && (
              <>
                <span>window</span>
                <b>{curSeries || "DreamDEX"} · closes {clock(cur.expiry)}</b>
                <span>pool</span>
                <b>
                  <a href={addrUrl(cur.pool)} target="_blank" rel="noreferrer">
                    {cur.pool}
                  </a>
                </b>
                <span>market</span>
                <b>
                  <a href={addrUrl(cur.market)} target="_blank" rel="noreferrer">
                    {cur.market}
                  </a>
                </b>
                <span>marketId</span>
                <b>{cur.marketId}</b>
                <span>outcome ids</span>
                <b>
                  up {cur.yesId.toString().slice(0, 12)}… · down {cur.noId.toString().slice(0, 12)}…
                </b>
              </>
            )}
            <span>rules</span>
            <b className="muted">
              matched stake → mintSet at 0.50 · surplus → IOC on the book at ≤ 0.55 · outcome read from the market contract · winners redeem through the module
            </b>
          </div>
        </div>
      </div>
    </div>
  );
}

function FeedRow({ e }: { e: FeedItem }) {
  const a = e.args;
  let cls = "";
  let text: JSX.Element | string = e.name;
  switch (e.name) {
    case "LobbyCreated":
      text = <span>lobby opened · stake <b>{fmtUsd(BigInt(a.stake))}</b></span>;
      break;
    case "Joined":
      text = <span><b>{short(a.player)}</b> joined · pot {fmtUsd(BigInt(a.pot))}</span>;
      break;
    case "Left":
      text = <span><b>{short(a.player)}</b> left</span>;
      break;
    case "RoundStarted":
      cls = "lock";
      text = <span>round <b>{String(a.round)}</b> started · closes {clock(Number(a.expiry))}</span>;
      break;
    case "Called":
      cls = Number(a.side) === Side.Up ? "win" : "kill";
      text = <span><b>{short(a.player)}</b> calls <b>{sideName(Number(a.side))}</b></span>;
      break;
    case "RoundExecuted":
      cls = "lock";
      text = <span>locked on DreamDEX · <b>{fmtQty(BigInt(a.setsMinted))}</b> sets minted{BigInt(a.bookFilled) > 0n ? <> · {fmtQty(BigInt(a.bookFilled))} from book</> : null} · {fmtUsd(BigInt(a.spent))} in play</span>;
      break;
    case "Eliminated":
      cls = "kill";
      text = <span><b>{short(a.player)}</b> eliminated · called {sideName(Number(a.called))}, market {sideName(Number(a.winner))}</span>;
      break;
    case "RoundFinalized":
      cls = "win";
      text = <span>round <b>{String(a.round)}</b> {a.voided ? "voided" : <>went <b>{sideName(Number(a.winner))}</b></>} · {String(a.eliminated)} out · {String(a.alive)} alive · pot {fmtUsd(BigInt(a.pot))}</span>;
      break;
    case "LobbyFinished":
      cls = "win";
      text = <span>game over · <b>{String(a.survivors)}</b> survivor{Number(a.survivors) === 1 ? "" : "s"} · {fmtUsd(BigInt(a.payoutPerSurvivor))} each</span>;
      break;
    case "Claimed":
      text = <span><b>{short(a.player)}</b> claimed {fmtUsd(BigInt(a.amount))}</span>;
      break;
  }
  return (
    <div className={`ev ${cls}`}>
      <span>{text}</span>
      <a href={txUrl(e.tx)} target="_blank" rel="noreferrer">
        tx ↗
      </a>
    </div>
  );
}
