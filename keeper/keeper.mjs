// Last Call keeper: starts rounds on live DreamDEX windows, locks them in, and
// finalizes them once the market resolves. Everything it calls is permissionless,
// so anyone can run one; the UI exposes the same buttons.
//
//   SERIES=BTC/300 node keeper/keeper.mjs        (default BTC 5-minute windows)
import { loadDeployment, pub, walletFor, send, refreshMarkets, liveMarkets, marketState, log, sleep, now } from "./common.mjs";

const dep = loadDeployment();
const w = walletFor(process.env.PRIVATE_KEY);
const SERIES = process.env.SERIES || "BTC/300";
const MIN_LEAD = 150;
const contract = { address: dep.address, abi: dep.abi };

const read = (fn, args = []) => pub.readContract({ ...contract, functionName: fn, args });

log(`keeper ${w.account.address} on ${dep.address}, series ${SERIES}`);

async function tick() {
  await refreshMarkets(2);
  const count = Number(await read("lobbyCount"));
  for (let id = 1; id <= count; id++) {
    try {
      await handleLobby(id);
    } catch (e) {
      log(`lobby ${id}: ${(e.shortMessage || e.message || String(e)).split("\n")[0]}`);
    }
  }
}

async function handleLobby(id) {
  const l = await read("getLobby", [BigInt(id)]);
  const state = Number(l.state); // 0 Open 1 Live 2 Finished 3 Cancelled
  if (state >= 2) return;
  const players = await read("getPlayers", [BigInt(id)]);
  if (state === 0 && players.length < Number(l.minPlayers)) return;
  if (state === 0 && process.env.AUTO_START === "false") return;

  const roundIdx = Number(l.roundCount);
  const r = roundIdx > 0 ? await read("getRound", [BigInt(id), BigInt(roundIdx)]) : null;
  const rs = r ? Number(r.state) : 3; // 1 Calling 2 Executed 3 Finalized
  const t = now();

  if (rs === 3) {
    if (roundIdx >= Number(l.maxRounds)) return;
    const m = liveMarkets(SERIES).find((x) => Number(x.expiry) >= t + MIN_LEAD + 20);
    if (!m) return;
    log(`lobby ${id}: starting round ${roundIdx + 1} on ${m.asset} ${Number(m.intervalSec) / 60}m window closing ${new Date(Number(m.expiry) * 1000).toISOString().slice(11, 19)}`);
    await send(w, { ...contract, functionName: "startRound", args: [BigInt(id), m.pool, m.marketId] }, `startRound(${id})`);
    return;
  }
  if (rs === 1) {
    const deadline = Number(r.callDeadline), expiry = Number(r.expiry);
    if (t >= deadline && t < expiry - 20) {
      log(`lobby ${id}: locking round ${roundIdx} (up ${r.upCount} / down ${r.downCount})`);
      await send(w, { ...contract, functionName: "executeRound", args: [BigInt(id)] }, `executeRound(${id})`);
      return;
    }
    if (t < expiry) return;
  }
  // Executed, or Calling past expiry (wash): finalize once the market is terminal.
  const { resolved, voided } = await marketState(r.market);
  if (!resolved && !voided) return;
  log(`lobby ${id}: finalizing round ${roundIdx} (${resolved ? "resolved" : "voided"})`);
  await send(w, { ...contract, functionName: "finalizeRound", args: [BigInt(id)] }, `finalizeRound(${id})`);
}

for (;;) {
  try {
    await tick();
  } catch (e) {
    log(`tick failed: ${(e.shortMessage || e.message).split("\n")[0]}`);
  }
  await sleep(Number(process.env.TICK_MS || 4000));
}
