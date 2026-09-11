// Chain access for the Discord bot: arena contract, custodial player wallets,
// funding from the operator, and the DreamDEX reads the info commands need.
import { createPublicClient, createWalletClient, http, parseAbi, formatUnits, parseEther, decodeEventLog } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { somniaTestnet } from "viem/chains";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { config } from "dotenv";
config({ path: new URL("../.env", import.meta.url) });
config({ path: new URL("./.env", import.meta.url) });

export const RPC = process.env.RPC_URL || "https://dream-rpc.somnia.network";
export const pub = createPublicClient({ chain: somniaTestnet, transport: http(RPC, { batch: true }), batch: { multicall: true } });
export const EXPLORER = "https://shannon-explorer.somnia.network";
export const APP = process.env.APP_URL || "https://soy-praveen.github.io/last-call/";
export const COLLATERAL = "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E";
export const OUTCOME = "0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9";
export const MODULE = "0x3ecC694Cef705358864a646142ac17A90E29e388";

const dep = JSON.parse(readFileSync(new URL("../contracts/out/deployment.json", import.meta.url), "utf8"));
export const ARENA = dep.address;
export const abi = JSON.parse(readFileSync(new URL("../contracts/out/LastCall.json", import.meta.url), "utf8")).abi;
export const arena = { address: ARENA, abi };

export const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function faucet(uint256 amount)",
]);
export const erc6909 = parseAbi(["function balanceOf(address owner, uint256 id) view returns (uint256)"]);
export const marketAbi = parseAbi(["function isResolved() view returns (bool)", "function isVoided() view returns (bool)", "function payoutNumerators() view returns (uint256[])"]);
export const poolAbi = parseAbi(["function getBookLevels(bool isBid, uint64 n) view returns ((uint256 price, uint256 quantity)[])"]);

export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
export const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export const usd = (v) => Number(formatUnits(BigInt(v), 6)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const now = () => Math.floor(Date.now() / 1000);

// ------------------------------------------------------------ wallets

const STATE = new URL("./state/players.json", import.meta.url);
mkdirSync(new URL("./state/", import.meta.url), { recursive: true });
const secret = createHash("sha256").update(process.env.BOT_SECRET || process.env.PRIVATE_KEY).digest();
const enc = (pk) => {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", secret, iv);
  const out = Buffer.concat([c.update(pk, "utf8"), c.final()]);
  return `${iv.toString("hex")}:${c.getAuthTag().toString("hex")}:${out.toString("hex")}`;
};
const dec = (s) => {
  const [iv, tag, data] = s.split(":");
  const d = createDecipheriv("aes-256-gcm", secret, Buffer.from(iv, "hex"));
  d.setAuthTag(Buffer.from(tag, "hex"));
  return Buffer.concat([d.update(Buffer.from(data, "hex")), d.final()]).toString("utf8");
};
const players = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
const save = () => writeFileSync(STATE, JSON.stringify(players, null, 1));

export const operator = (() => {
  const account = privateKeyToAccount(process.env.PRIVATE_KEY);
  return { account, client: createWalletClient({ chain: somniaTestnet, transport: http(RPC), account }) };
})();

/** The custodial wallet for a Discord user, created on first use. */
export function walletOf(discordId, name) {
  if (!players[discordId]) {
    const pk = generatePrivateKey();
    players[discordId] = { key: enc(pk), address: privateKeyToAccount(pk).address, name, created: now() };
    save();
    log(`new player ${name} ${players[discordId].address}`);
  }
  const pk = dec(players[discordId].key);
  const account = privateKeyToAccount(pk);
  return { account, address: account.address, pk, client: createWalletClient({ chain: somniaTestnet, transport: http(RPC), account }) };
}
export const knownPlayers = () => Object.fromEntries(Object.entries(players).map(([id, p]) => [p.address.toLowerCase(), { id, name: p.name }]));

// per-wallet send queue so one user's actions never race their own nonce
const queues = new Map();
export async function send(w, req, label) {
  const key = w.address.toLowerCase();
  const prev = queues.get(key) || Promise.resolve();
  const run = prev.then(async () => {
    const fees = await pub.estimateFeesPerGas();
    const gas = await pub.estimateContractGas({ ...req, account: w.account });
    const hash = await w.client.writeContract({ ...req, gas: (gas * 15n) / 10n, maxFeePerGas: fees.maxFeePerGas * 2n, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${label} reverted`);
    log(`${label} ok ${hash}`);
    return hash;
  });
  queues.set(key, run.catch(() => {}));
  return run;
}

/** Make sure a player wallet has gas and collateral; returns what it did. */
export async function ensureFunded(w, needUsd = 5_000_000n) {
  const did = [];
  const stt = await pub.getBalance({ address: w.address });
  if (stt < parseEther("0.05")) {
    const op = operator;
    const key = op.account.address.toLowerCase();
    const prev = queues.get(key) || Promise.resolve();
    const run = prev.then(async () => {
      const fees = await pub.estimateFeesPerGas();
      const hash = await op.client.sendTransaction({ to: w.address, value: parseEther("0.3"), maxFeePerGas: fees.maxFeePerGas * 2n, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
      await pub.waitForTransactionReceipt({ hash });
    });
    queues.set(key, run.catch(() => {}));
    await run;
    did.push("gas topped up");
  }
  const bal = await pub.readContract({ address: COLLATERAL, abi: erc20, functionName: "balanceOf", args: [w.address] });
  if (bal < needUsd) {
    await send(w, { address: COLLATERAL, abi: erc20, functionName: "faucet", args: [50_000_000n] }, `faucet ${short(w.address)}`);
    did.push("50 tUSDC from the faucet");
  }
  const allowance = await pub.readContract({ address: COLLATERAL, abi: erc20, functionName: "allowance", args: [w.address, ARENA] });
  if (allowance < 10n ** 12n) {
    await send(w, { address: COLLATERAL, abi: erc20, functionName: "approve", args: [ARENA, 2n ** 255n] }, `approve ${short(w.address)}`);
    did.push("arena approved");
  }
  return did;
}

// ------------------------------------------------------------ arena reads

const read = (fn, args = []) => pub.readContract({ ...arena, functionName: fn, args });
export async function lobbies(limit = 12) {
  const count = Number(await read("lobbyCount"));
  const ids = Array.from({ length: Math.min(limit, count) }, (_, i) => count - i);
  const rows = await Promise.all(ids.map((id) => read("getLobby", [BigInt(id)])));
  return rows.map((l, i) => ({ id: ids[i], state: Number(l.state), name: l.name, stake: l.stake, pot: l.pot, alive: Number(l.alive), roundCount: Number(l.roundCount), maxRounds: Number(l.maxRounds), minPlayers: Number(l.minPlayers), maxPlayers: Number(l.maxPlayers), payout: l.payoutPerSurvivor }));
}
export async function lobby(id) {
  const [l, ps, rs] = await Promise.all([read("getLobby", [BigInt(id)]), read("getPlayerStates", [BigInt(id)]), read("getRounds", [BigInt(id)])]);
  const players = ps[0].map((a, i) => ({ address: a, alive: ps[1][i], call: Number(ps[2][i]), outRound: Number(ps[3][i]) }));
  const rounds = rs.map((r, i) => ({ index: i + 1, state: Number(r.state), expiry: Number(r.expiry), callDeadline: Number(r.callDeadline), upCount: Number(r.upCount), downCount: Number(r.downCount), setsMinted: r.setsMinted, bookFilled: r.bookFilled, spent: r.spent, returned: r.returned, winner: Number(r.winner), voided: r.voided, eliminated: Number(r.eliminated), market: r.market, pool: r.pool }));
  return { id, state: Number(l.state), name: l.name, stake: l.stake, pot: l.pot, alive: Number(l.alive), roundCount: Number(l.roundCount), maxRounds: Number(l.maxRounds), minPlayers: Number(l.minPlayers), maxPlayers: Number(l.maxPlayers), payout: l.payoutPerSurvivor, players, rounds, cur: rounds[rounds.length - 1] || null };
}
export const openLobby = async () => (await lobbies()).find((l) => l.state === 0) || null;
export const liveLobbies = async () => (await lobbies()).filter((l) => l.state === 1);

export const eventAbis = abi.filter((x) => x.type === "event");
export async function arenaEvents(fromBlock, toBlock) {
  const logs = await pub.getLogs({ address: ARENA, events: eventAbis, fromBlock, toBlock });
  return logs
    .map((l) => {
      try {
        const d = decodeEventLog({ abi, data: l.data, topics: l.topics });
        return { name: d.eventName, args: d.args, tx: l.transactionHash, block: l.blockNumber };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// ------------------------------------------------------------ info reads

export async function unclaimedOf(address) {
  const r = await fetch("https://soy-praveen.github.io/unclaimed/data/snapshot.json");
  const snap = await r.json();
  const terminal = snap.markets.filter((m) => m.resolved || m.voided);
  const calls = terminal.flatMap((m) => [
    { address: OUTCOME, abi: erc6909, functionName: "balanceOf", args: [address, BigInt(m.yesId)] },
    { address: OUTCOME, abi: erc6909, functionName: "balanceOf", args: [address, BigInt(m.noId)] },
  ]);
  const res = await pub.multicall({ contracts: calls, allowFailure: true });
  let total = 0n, n = 0;
  terminal.forEach((m, i) => {
    for (const [side, v] of [[0, res[i * 2].result], [1, res[i * 2 + 1].result]]) {
      if (!v || v <= 0n) continue;
      const frac = m.payoutFrac[side] || 0;
      if (frac > 0) {
        total += BigInt(Math.floor(Number(v) * frac));
        n++;
      }
    }
  });
  return { total, positions: n, windows: snap.stats.windows, generatedAt: snap.generatedAt, unclaimedTotal: BigInt(snap.stats.unclaimedTotal), holders: snap.stats.unclaimedHolders };
}

const marketCreated = {
  type: "event",
  name: "MarketCreated",
  inputs: [
    { name: "marketId", type: "bytes32", indexed: true }, { name: "market", type: "address", indexed: true }, { name: "pool", type: "address", indexed: true },
    { name: "oracleQuestionId", type: "uint256", indexed: false }, { name: "operatorId", type: "uint32", indexed: false }, { name: "venueId", type: "bytes32", indexed: false },
    { name: "creator", type: "address", indexed: false }, { name: "collateral", type: "address", indexed: false }, { name: "yesId", type: "uint256", indexed: false },
    { name: "noId", type: "uint256", indexed: false }, { name: "nonce", type: "uint64", indexed: false }, { name: "outcomeSlotCount", type: "uint8", indexed: false },
    { name: "marketType", type: "uint8", indexed: false }, { name: "tradingStart", type: "uint64", indexed: false }, { name: "expiry", type: "uint64", indexed: false },
    { name: "voidPolicy", type: "uint8", indexed: false }, { name: "asset", type: "string", indexed: false }, { name: "strike", type: "uint256", indexed: false },
    { name: "question", type: "string", indexed: false }, { name: "context", type: "bytes", indexed: false },
  ],
};
export async function basisNow() {
  const head = await pub.getBlockNumber();
  const pages = await Promise.all([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => pub.getLogs({ address: MODULE, event: marketCreated, fromBlock: head - BigInt(i * 1000) - 999n, toBlock: head - BigInt(i * 1000) }).catch(() => [])));
  const t = now();
  const wins = pages.flat().map((l) => l.args).filter((a) => a.collateral.toLowerCase() === COLLATERAL.toLowerCase() && Number(a.expiry) > t);
  const out = [];
  for (const [asset, sec] of [["BTC", 300], ["ETH", 300], ["BTC", 900], ["ETH", 900]]) {
    const start = Math.floor(t / sec) * sec, end = start + sec;
    const w = wins.find((a) => a.asset === asset && Number(a.expiry) === end);
    let dream = null;
    if (w) {
      const [b, a] = await Promise.all([
        pub.readContract({ address: w.pool, abi: poolAbi, functionName: "getBookLevels", args: [true, 1n] }),
        pub.readContract({ address: w.pool, abi: poolAbi, functionName: "getBookLevels", args: [false, 1n] }),
      ]);
      const bid = b[0] ? Number(b[0].price) / 1e6 : null, ask = a[0] ? Number(a[0].price) / 1e6 : null;
      dream = bid !== null && ask !== null ? (bid + ask) / 2 : bid ?? ask;
    }
    let poly = null;
    try {
      const ev = await fetch(`https://gamma-api.polymarket.com/events?slug=${asset.toLowerCase()}-updown-${sec / 60}m-${start}`).then((r) => r.json());
      const [up] = JSON.parse(ev?.[0]?.markets?.[0]?.clobTokenIds || "[]");
      if (up) {
        const book = await fetch(`https://clob.polymarket.com/book?token_id=${up}`).then((r) => r.json());
        const bid = Math.max(0, ...(book.bids || []).map((l) => Number(l.price))), ask = Math.min(1, ...(book.asks || []).map((l) => Number(l.price)));
        poly = bid > 0 && ask < 1 ? (bid + ask) / 2 : bid > 0 ? bid : ask < 1 ? ask : null;
      }
    } catch {}
    out.push({ series: `${asset} ${sec / 60}m`, end, dream, poly });
  }
  return out;
}
