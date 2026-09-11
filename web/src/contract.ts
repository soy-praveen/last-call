import { type Abi, type Address, type Hex, decodeEventLog, parseAbiItem } from "viem";
import dep from "./deployment.json";
import { pub, type Wallet } from "./chain";

export const ARENA = dep.address as Address;
export const COLLATERAL = dep.collateral as Address;
export const DEPLOY_BLOCK = BigInt(dep.block || 0);
export const abi = dep.abi as Abi;
export const MARKET_CREATOR: Address = "0x138CfA6b80475b8c03d7E468b2442278E51e645a";

export const erc20Abi = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "allowance", type: "function", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] },
  { name: "faucet", type: "function", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }], outputs: [] },
] as const;

export const marketAbi = [
  { name: "isResolved", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { name: "isVoided", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { name: "status", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

export const marketCreatedEvent = parseAbiItem(
  "event MarketCreated(bytes32 indexed marketId, address indexed market, address indexed pool, uint256 yesId, uint256 noId, address collateral, string asset, uint256 strike, uint64 tradingStart, uint64 expiry, uint256 oracleQuestionId, string question, uint64 intervalSec)"
);

export enum Side { None = 0, Up = 1, Down = 2 }
export enum LobbyState { Open = 0, Live = 1, Finished = 2, Cancelled = 3 }
export enum RoundState { None = 0, Calling = 1, Executed = 2, Finalized = 3 }

export type Lobby = {
  id: number;
  creator: Address;
  name: string;
  stake: bigint;
  minPlayers: number;
  maxPlayers: number;
  maxRounds: number;
  state: LobbyState;
  pot: bigint;
  alive: number;
  roundCount: number;
  payoutPerSurvivor: bigint;
  createdAt: number;
  createdBlock: bigint;
};

export type Round = {
  index: number;
  pool: Address;
  market: Address;
  outcomeToken: Address;
  marketId: Hex;
  yesId: bigint;
  noId: bigint;
  expiry: number;
  callDeadline: number;
  state: RoundState;
  upCount: number;
  downCount: number;
  upStake: bigint;
  downStake: bigint;
  setsMinted: bigint;
  bookFilled: bigint;
  bookSide: Side;
  spent: bigint;
  returned: bigint;
  winner: Side;
  voided: boolean;
  eliminated: number;
};

export type PlayerState = { address: Address; alive: boolean; call: Side; outRound: number };

export type LiveMarket = {
  marketId: Hex;
  market: Address;
  pool: Address;
  asset: string;
  intervalSec: number;
  tradingStart: number;
  expiry: number;
};

const read = (functionName: string, args: unknown[] = []) => pub.readContract({ address: ARENA, abi, functionName, args }) as Promise<any>;

function toLobby(id: number, l: any): Lobby {
  return {
    id,
    creator: l.creator,
    name: l.name,
    stake: BigInt(l.stake),
    minPlayers: Number(l.minPlayers),
    maxPlayers: Number(l.maxPlayers),
    maxRounds: Number(l.maxRounds),
    state: Number(l.state),
    pot: BigInt(l.pot),
    alive: Number(l.alive),
    roundCount: Number(l.roundCount),
    payoutPerSurvivor: BigInt(l.payoutPerSurvivor),
    createdAt: Number(l.createdAt),
    createdBlock: BigInt(l.createdBlock),
  };
}

function toRound(index: number, r: any): Round {
  return {
    index,
    pool: r.pool,
    market: r.market,
    outcomeToken: r.outcomeToken,
    marketId: r.marketId,
    yesId: BigInt(r.yesId),
    noId: BigInt(r.noId),
    expiry: Number(r.expiry),
    callDeadline: Number(r.callDeadline),
    state: Number(r.state),
    upCount: Number(r.upCount),
    downCount: Number(r.downCount),
    upStake: BigInt(r.upStake),
    downStake: BigInt(r.downStake),
    setsMinted: BigInt(r.setsMinted),
    bookFilled: BigInt(r.bookFilled),
    bookSide: Number(r.bookSide),
    spent: BigInt(r.spent),
    returned: BigInt(r.returned),
    winner: Number(r.winner),
    voided: Boolean(r.voided),
    eliminated: Number(r.eliminated),
  };
}

export async function fetchLobbyCount(): Promise<number> {
  return Number(await read("lobbyCount"));
}

export async function fetchLobbies(): Promise<Lobby[]> {
  const n = await fetchLobbyCount();
  const ids = Array.from({ length: n }, (_, i) => n - i);
  const rows = await Promise.all(ids.map((id) => read("getLobby", [BigInt(id)])));
  return rows.map((r, i) => toLobby(ids[i], r));
}

export async function fetchLobby(id: number): Promise<Lobby> {
  return toLobby(id, await read("getLobby", [BigInt(id)]));
}

export async function fetchRounds(id: number): Promise<Round[]> {
  const rows = (await read("getRounds", [BigInt(id)])) as any[];
  return rows.map((r, i) => toRound(i + 1, r));
}

export async function fetchPlayers(id: number): Promise<PlayerState[]> {
  const [addrs, alive, calls, out] = (await read("getPlayerStates", [BigInt(id)])) as [Address[], boolean[], number[], bigint[]];
  return addrs.map((a, i) => ({ address: a, alive: alive[i], call: Number(calls[i]), outRound: Number(out[i]) }));
}

export async function marketTerminal(market: Address): Promise<{ resolved: boolean; voided: boolean }> {
  const [resolved, voided] = await Promise.all([
    pub.readContract({ address: market, abi: marketAbi, functionName: "isResolved" }),
    pub.readContract({ address: market, abi: marketAbi, functionName: "isVoided" }),
  ]);
  return { resolved, voided };
}

export async function collateralBalance(who: Address): Promise<bigint> {
  return pub.readContract({ address: COLLATERAL, abi: erc20Abi, functionName: "balanceOf", args: [who] });
}

/** Live DreamDEX windows (tUSDC), scanned from MarketCreated logs. */
export async function fetchLiveMarkets(): Promise<LiveMarket[]> {
  const head = await pub.getBlockNumber();
  const now = Math.floor(Date.now() / 1000);
  const out = new Map<string, LiveMarket>();
  for (let i = 0; i < 4; i++) {
    const to = head - BigInt(i * 1000);
    try {
      const logs = await pub.getLogs({ event: marketCreatedEvent, fromBlock: to - 999n, toBlock: to });
      for (const l of logs) {
        const a = l.args;
        if (!a.marketId || !a.pool || !a.market) continue;
        if ((a.collateral || "").toLowerCase() !== COLLATERAL.toLowerCase()) continue;
        if (Number(a.expiry) <= now) continue;
        out.set(a.marketId, {
          marketId: a.marketId,
          market: a.market,
          pool: a.pool,
          asset: a.asset || "",
          intervalSec: Number(a.intervalSec),
          tradingStart: Number(a.tradingStart),
          expiry: Number(a.expiry),
        });
      }
    } catch {
      /* best effort */
    }
  }
  return [...out.values()].sort((a, b) => a.expiry - b.expiry);
}

// ---------------------------------------------------------------- events

export type FeedItem = {
  key: string;
  block: bigint;
  tx: Hex;
  name: string;
  args: Record<string, any>;
};

const eventAbis = (abi as any[]).filter((x) => x.type === "event");

export async function fetchFeed(lobbyId: number, fromBlock: bigint, toBlock?: bigint): Promise<{ items: FeedItem[]; head: bigint; raw: number; pages: number; err: string }> {
  const head = toBlock ?? (await pub.getBlockNumber());
  const ranges: [bigint, bigint][] = [];
  for (let from = fromBlock; from <= head && ranges.length < 120; from += 1000n) {
    ranges.push([from, from + 999n > head ? head : from + 999n]);
  }
  const items: FeedItem[] = [];
  let raw = 0;
  let err = "";
  // pages are independent, fetch them in parallel batches
  for (let i = 0; i < ranges.length; i += 8) {
    const batch = ranges.slice(i, i + 8);
    const results = await Promise.all(
      batch.map(([from, to]) => pub.getLogs({ address: ARENA, events: eventAbis as any, fromBlock: from, toBlock: to }).catch((e) => ((err = String(e?.shortMessage || e?.message || e).slice(0, 160)), console.warn("feed page failed", e), [])))
    );
    for (const logs of results) {
      raw += (logs as any[]).length;
      for (const l of logs as any[]) {
        try {
          const d = decodeEventLog({ abi, data: l.data, topics: l.topics }) as any;
          const args = d.args || {};
          if (args.lobbyId !== undefined && Number(args.lobbyId) !== lobbyId) continue;
          items.push({ key: `${l.transactionHash}-${l.logIndex}`, block: l.blockNumber, tx: l.transactionHash, name: d.eventName, args });
        } catch (e) {
          err = "decode: " + String((e as any)?.message).slice(0, 120);
          console.warn("feed decode failed", e);
        }
      }
    }
  }
  items.sort((a, b) => (a.block === b.block ? 0 : a.block < b.block ? -1 : 1));
  return { items, head, raw, pages: ranges.length, err };
}

// ---------------------------------------------------------------- writes

async function write(w: Wallet, functionName: string, args: unknown[], address: Address = ARENA, useAbi: Abi = abi): Promise<Hex> {
  const gas = await pub.estimateContractGas({ address, abi: useAbi, functionName, args, account: w.address });
  const hash = await w.client.writeContract({ address, abi: useAbi, functionName, args, account: w.address, chain: pub.chain, gas: (gas * 13n) / 10n });
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  if (rcpt.status !== "success") throw new Error("Transaction reverted");
  return hash;
}

export const tx = {
  createLobby: (w: Wallet, name: string, stake: bigint, min: number, max: number, rounds: number) => write(w, "createLobby", [name, stake, min, max, rounds]),
  approve: (w: Wallet) => write(w, "approve", [ARENA, 2n ** 255n], COLLATERAL, erc20Abi as unknown as Abi),
  faucet: (w: Wallet) => write(w, "faucet", [50_000_000n], COLLATERAL, erc20Abi as unknown as Abi),
  join: (w: Wallet, id: number) => write(w, "join", [BigInt(id)]),
  leave: (w: Wallet, id: number) => write(w, "leaveLobby", [BigInt(id)]),
  call: (w: Wallet, id: number, side: Side) => write(w, "call", [BigInt(id), side]),
  startRound: (w: Wallet, id: number, pool: Address, marketId: Hex) => write(w, "startRound", [BigInt(id), pool, marketId]),
  executeRound: (w: Wallet, id: number) => write(w, "executeRound", [BigInt(id)]),
  finalizeRound: (w: Wallet, id: number) => write(w, "finalizeRound", [BigInt(id)]),
  claim: (w: Wallet, id: number) => write(w, "claim", [BigInt(id)]),
};

export async function allowance(owner: Address): Promise<bigint> {
  return pub.readContract({ address: COLLATERAL, abi: erc20Abi, functionName: "allowance", args: [owner, ARENA] });
}
