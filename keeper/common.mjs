// Shared chain setup for the keeper and the crowd bots.
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { somniaTestnet } from "viem/chains";
import { readFileSync, existsSync } from "fs";
import { config } from "dotenv";
import { marketCreatedEvent, binaryMarketAbi, binaryPoolAbi, erc20Abi } from "./abi.mjs";
config();

export const RPC = process.env.RPC_URL || "https://dream-rpc.somnia.network";
export const MARKET_CREATOR = "0x138CfA6b80475b8c03d7E468b2442278E51e645a";
export const COLLATERAL = "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E";
export const ONE = 1_000_000n;

export const pub = createPublicClient({ chain: somniaTestnet, transport: http(RPC) });

export function walletFor(pk) {
  const account = privateKeyToAccount(pk);
  return { account, wallet: createWalletClient({ chain: somniaTestnet, transport: http(RPC), account }) };
}

export function loadDeployment() {
  const p = new URL("../contracts/out/deployment.json", import.meta.url);
  if (!existsSync(p)) throw new Error("no deployment.json, run npm run deploy first");
  const dep = JSON.parse(readFileSync(p, "utf8"));
  const { abi } = JSON.parse(readFileSync(new URL("../contracts/out/LastCall.json", import.meta.url), "utf8"));
  return { ...dep, abi };
}

export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const now = () => Math.floor(Date.now() / 1000);

/// Send a write with Somnia-friendly fees, wait for the receipt, throw on revert.
export async function send(w, req, label) {
  const fees = await pub.estimateFeesPerGas();
  const gas = await pub.estimateContractGas({ ...req, account: w.account });
  const hash = await w.wallet.writeContract({
    ...req,
    gas: (gas * 15n) / 10n,
    maxFeePerGas: fees.maxFeePerGas * 2n,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  });
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  if (rcpt.status !== "success") throw new Error(`${label || req.functionName} reverted: ${hash}`);
  log(`${label || req.functionName} ok ${hash}`);
  return rcpt;
}

const seen = new Map(); // marketId -> market row

/// Scan recent MarketCreated logs (best effort, 1000-block pages) and merge into the cache.
export async function refreshMarkets(pages = 3) {
  const head = await pub.getBlockNumber();
  for (let i = 0; i < pages; i++) {
    const to = head - BigInt(i * 1000);
    try {
      const logs = await pub.getLogs({ event: marketCreatedEvent, fromBlock: to - 999n, toBlock: to });
      for (const l of logs) seen.set(l.args.marketId, { ...l.args, block: l.blockNumber });
    } catch {}
  }
  return [...seen.values()];
}

/// Live tUSDC windows sorted by expiry. `series` like "BTC/300" filters asset/interval.
export function liveMarkets(series) {
  const t = now();
  let rows = [...seen.values()].filter((m) => Number(m.expiry) > t && m.collateral.toLowerCase() === COLLATERAL.toLowerCase());
  if (series) {
    const [asset, sec] = series.split("/");
    rows = rows.filter((m) => m.asset === asset && Number(m.intervalSec) === Number(sec));
  }
  return rows.sort((a, b) => Number(a.expiry) - Number(b.expiry));
}

export async function marketState(market) {
  const [resolved, voided] = await Promise.all([
    pub.readContract({ address: market, abi: binaryMarketAbi, functionName: "isResolved" }),
    pub.readContract({ address: market, abi: binaryMarketAbi, functionName: "isVoided" }),
  ]);
  return { resolved, voided };
}

export { binaryMarketAbi, binaryPoolAbi, erc20Abi };
