// A crowd of bot players for a lobby. Creates and funds burner wallets from the
// operator key, joins them to a lobby, and has each one call UP or DOWN every
// round with its own personality. Used to fill the arena for demos and testing.
//
//   node keeper/crowd.mjs fund 10              create/fund 10 wallets (STT + tUSDC)
//   node keeper/crowd.mjs join <lobbyId> [n]   join n wallets to a lobby
//   node keeper/crowd.mjs play <lobbyId>       keep calling every round until the lobby ends
//   node keeper/crowd.mjs create "<name>" <stake> <min> <max> <rounds>   create a lobby from the operator
import { readFileSync, writeFileSync, existsSync } from "fs";
import { parseEther, formatEther, parseUnits } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { loadDeployment, pub, walletFor, send, log, sleep, now, erc20Abi, COLLATERAL, ONE } from "./common.mjs";

const dep = loadDeployment();
const contract = { address: dep.address, abi: dep.abi };
const op = walletFor(process.env.PRIVATE_KEY);
const WALLETS = new URL("./wallets.json", import.meta.url);
const NAMES = ["ada", "bruno", "chen", "dima", "eli", "farah", "gus", "hana", "ivo", "juno", "kai", "lena", "milo", "nia", "otto", "pia"];
const read = (fn, args = []) => pub.readContract({ ...contract, functionName: fn, args });

function loadWallets() {
  return existsSync(WALLETS) ? JSON.parse(readFileSync(WALLETS, "utf8")) : [];
}

const [cmd, a1, a2, a3, a4, a5] = process.argv.slice(2);

if (cmd === "fund") {
  const n = Number(a1 || 8);
  const ws = loadWallets();
  while (ws.length < n) {
    const pk = generatePrivateKey();
    ws.push({ name: NAMES[ws.length % NAMES.length], pk, persona: ["momentum", "contrarian", "coin", "bull", "bear"][ws.length % 5] });
  }
  writeFileSync(WALLETS, JSON.stringify(ws, null, 2));
  const stt = parseEther(process.env.CROWD_STT || "0.4");
  const usdc = parseUnits(process.env.CROWD_USDC || "12", 6);
  for (const b of ws.slice(0, n)) {
    const { account } = walletFor(b.pk);
    const bal = await pub.getBalance({ address: account.address });
    if (bal < stt / 2n) {
      const fees = await pub.estimateFeesPerGas();
      const hash = await op.wallet.sendTransaction({ to: account.address, value: stt, maxFeePerGas: fees.maxFeePerGas * 2n, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
      await pub.waitForTransactionReceipt({ hash });
      log(`${b.name} ${account.address} +${formatEther(stt)} STT`);
    }
    const ub = await pub.readContract({ address: COLLATERAL, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
    if (ub < usdc / 2n) {
      await send(op, { address: COLLATERAL, abi: erc20Abi, functionName: "transfer", args: [account.address, usdc] }, `${b.name} +${Number(usdc) / 1e6} tUSDC`);
    }
  }
  log(`${n} wallets ready`);
  process.exit(0);
}

if (cmd === "create") {
  const [name, stake, min, max, rounds] = [a1 || "Arena", a2 || "5", a3 || "2", a4 || "16", a5 || "6"];
  const rcpt = await send(op, { ...contract, functionName: "createLobby", args: [name, parseUnits(stake, 6), Number(min), Number(max), Number(rounds)] }, "createLobby");
  log(`lobby created, lobbyCount now ${await read("lobbyCount")}`);
  process.exit(0);
}

if (cmd === "join") {
  const lobbyId = BigInt(a1);
  const n = Number(a2 || 8);
  const l = await read("getLobby", [lobbyId]);
  for (const b of loadWallets().slice(0, n)) {
    const w = walletFor(b.pk);
    if (await read("joined", [lobbyId, w.account.address])) continue;
    const allowance = await pub.readContract({ address: COLLATERAL, abi: erc20Abi, functionName: "allowance", args: [w.account.address, dep.address] });
    if (allowance < l.stake) await send(w, { address: COLLATERAL, abi: erc20Abi, functionName: "approve", args: [dep.address, 2n ** 255n] }, `${b.name} approve`);
    await send(w, { ...contract, functionName: "join", args: [lobbyId] }, `${b.name} join`);
    await sleep(Number(process.env.JOIN_GAP_MS || 1500));
  }
  process.exit(0);
}

if (cmd === "play") {
  const lobbyId = BigInt(a1);
  const bots = loadWallets().map((b) => ({ ...b, w: walletFor(b.pk), calledRound: 0, plan: 0 }));
  let lastWinner = 0;
  for (;;) {
    try {
      const l = await read("getLobby", [lobbyId]);
      if (Number(l.state) >= 2) { log("lobby over"); process.exit(0); }
      const idx = Number(l.roundCount);
      if (idx === 0) { await sleep(3000); continue; }
      const r = await read("getRound", [lobbyId, BigInt(idx)]);
      if (Number(r.state) === 3 && Number(r.winner) > 0) lastWinner = Number(r.winner);
      if (Number(r.state) !== 1) { await sleep(3000); continue; }
      const t = now();
      const deadline = Number(r.callDeadline);
      const open = deadline - t;
      for (const b of bots) {
        if (b.calledRound === idx) continue;
        if (!(await read("alive", [lobbyId, b.w.account.address]))) { b.calledRound = idx; continue; }
        // Each bot picks a random moment in the calling window so calls trickle in on screen.
        if (b.plan === 0) b.plan = t + Math.floor(Math.random() * Math.max(5, Math.min(open - 15, 120)));
        if (t < b.plan || open < 8) continue;
        const side = pick(b.persona, lastWinner);
        try {
          await send(b.w, { ...contract, functionName: "call", args: [lobbyId, side] }, `${b.name} calls ${side === 1 ? "UP" : "DOWN"}`);
        } catch (e) {
          log(`${b.name} call failed: ${(e.shortMessage || e.message).split("\n")[0]}`);
        }
        b.calledRound = idx;
        b.plan = 0;
      }
    } catch (e) {
      log(`play: ${(e.shortMessage || e.message).split("\n")[0]}`);
    }
    await sleep(2000);
  }
}

function pick(persona, lastWinner) {
  const coin = Math.random() < 0.5 ? 1 : 2;
  switch (persona) {
    case "bull": return Math.random() < 0.8 ? 1 : 2;
    case "bear": return Math.random() < 0.8 ? 2 : 1;
    case "momentum": return lastWinner ? (Math.random() < 0.75 ? lastWinner : 3 - lastWinner) : coin;
    case "contrarian": return lastWinner ? (Math.random() < 0.75 ? 3 - lastWinner : lastWinner) : coin;
    default: return coin;
  }
}

if (!["fund", "create", "join", "play"].includes(cmd)) {
  console.log("usage: crowd.mjs fund <n> | create <name> <stake> <min> <max> <rounds> | join <lobbyId> [n] | play <lobbyId>");
  process.exit(1);
}
