// List live DreamDEX event-contract windows on Shannon by scanning MarketCreated logs.
// No key needed. Usage: node keeper/discover.mjs [hours]
import { createPublicClient, http, formatUnits } from "viem";
import { somniaTestnet } from "viem/chains";
import { marketCreatedEvent } from "./abi.mjs";
import { SOMNIA_TESTNET_ADDRESSES } from "@somnia-chain/markets-sdk";
import { config } from "dotenv";
config();

const RPC = process.env.RPC_URL || "https://dream-rpc.somnia.network";
const pub = createPublicClient({ chain: somniaTestnet, transport: http(RPC) });
const ev = marketCreatedEvent;
const COLL = SOMNIA_TESTNET_ADDRESSES.testUsdc.toLowerCase();

const head = await pub.getBlockNumber();
const windows = Number(process.argv[2] || 40);
const found = [];
for (let i = 0; i < windows; i++) {
  const to = head - BigInt(i * 1000);
  try {
    const logs = await pub.getLogs({ event: ev, fromBlock: to - 999n, toBlock: to });
    for (const l of logs) found.push({ ...l.args, block: l.blockNumber, tx: l.transactionHash });
  } catch (e) { /* best effort */ }
}
const now = Math.floor(Date.now() / 1000);
found.sort((a, b) => Number(a.expiry) - Number(b.expiry));
console.log(`head block ${head}; scanned ${windows}k blocks; ${found.length} MarketCreated events`);
const byInterval = {};
for (const m of found) byInterval[`${m.asset}/${Number(m.intervalSec)}s`] = (byInterval[`${m.asset}/${Number(m.intervalSec)}s`] || 0) + 1;
console.log("series seen:", byInterval);
console.log("\nLIVE (tUSDC collateral):");
for (const m of found) {
  if (Number(m.expiry) <= now) continue;
  if ((m.collateral || "").toLowerCase() !== COLL) continue;
  console.log(`${m.asset.padEnd(4)} ${String(Number(m.intervalSec) / 60).padStart(3)}min  start=${new Date(Number(m.tradingStart) * 1000).toISOString().slice(11, 19)} exp=${new Date(Number(m.expiry) * 1000).toISOString().slice(11, 19)} (in ${Math.round((Number(m.expiry) - now) / 60)}m)  pool=${m.pool}  market=${m.market}  marketId=${m.marketId}  strike=${m.strike}`);
}
console.log("\nlast 5 expired:");
for (const m of found.filter((x) => Number(x.expiry) <= now).slice(-5)) {
  console.log(`${m.asset} ${Number(m.intervalSec) / 60}min exp=${new Date(Number(m.expiry) * 1000).toISOString().slice(11, 19)} pool=${m.pool} marketId=${m.marketId}`);
}
process.exit(0);
