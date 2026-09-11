// Last Call Discord bot. Every Discord user gets a custodial Shannon testnet wallet
// on first use, funded from the faucet, so /join, /up and /down are one tap on a
// phone. Lock, settle and start still happen on chain through the keeper; this bot
// only ever acts as the player.
//
//   DISCORD_TOKEN=... DISCORD_APP_ID=... node discord/bot.mjs
import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from "discord.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { pub, arena, abi, ARENA, APP, EXPLORER, COLLATERAL, erc20, walletOf, ensureFunded, send, lobbies, lobby, openLobby, liveLobbies, arenaEvents, unclaimedOf, basisNow, knownPlayers, usd, short, now, log } from "./chain.mjs";

const NEON = 0xc8ff2e, UP = 0x3dffb0, DOWN = 0xff4d6d, GREY = 0x5b667a;
const SETTINGS = new URL("./state/settings.json", import.meta.url);
const settings = existsSync(SETTINGS) ? JSON.parse(readFileSync(SETTINGS, "utf8")) : { channels: [] };
const saveSettings = () => writeFileSync(SETTINGS, JSON.stringify(settings, null, 1));

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const mmss = (s) => `${String(Math.floor(Math.max(0, s) / 60)).padStart(2, "0")}:${String(Math.max(0, s) % 60).padStart(2, "0")}`;
const hhmm = (t) => new Date(t * 1000).toISOString().slice(11, 16) + " UTC";
const stateName = ["open", "live", "finished", "cancelled"];
const sideName = (s) => (s === 1 ? "UP" : s === 2 ? "DOWN" : "no call");
const nameOf = (address) => {
  const p = knownPlayers()[address.toLowerCase()];
  return p && p.name ? `@${p.name}` : short(address);
};

// ------------------------------------------------------------ embeds

function arenaEmbed(l) {
  const t = now();
  const cur = l.cur;
  let phase = "waiting for players";
  if (l.state === 1 && cur) {
    if (cur.state === 1 && t < cur.callDeadline) phase = `round ${cur.index} · calls open · locks in ${mmss(cur.callDeadline - t)}`;
    else if (cur.state === 1) phase = `round ${cur.index} · locking in`;
    else if (cur.state === 2 && t < cur.expiry) phase = `round ${cur.index} · locked · window closes in ${mmss(cur.expiry - t)}`;
    else if (cur.state !== 3) phase = `round ${cur.index} · waiting for DreamDEX to resolve`;
    else phase = `round ${cur.index} settled · next round starting`;
  } else if (l.state === 2) phase = l.alive === 1 ? "finished · last one standing" : `finished · ${l.alive} survivors`;
  else if (l.state === 3) phase = "cancelled";

  const e = new EmbedBuilder()
    .setColor(l.state === 1 ? NEON : l.state === 2 ? UP : GREY)
    .setTitle(`#${l.id} ${l.name || "Arena"} · ${phase}`)
    .setURL(`${APP}#/lobby/${l.id}`)
    .addFields(
      { name: "Pot", value: `${usd(l.pot)} tUSDC`, inline: true },
      { name: "Alive", value: `${l.alive} / ${l.players.length}`, inline: true },
      { name: "Round", value: `${l.roundCount} / ${l.maxRounds}`, inline: true }
    );
  if (l.state === 0) e.addFields({ name: "Stake", value: `${usd(l.stake)} tUSDC · starts when ${l.minPlayers} have joined (${l.players.length} in)`, inline: false });
  if (cur && l.state === 1) {
    const total = cur.upCount + cur.downCount;
    const upPct = total ? Math.round((100 * cur.upCount) / total) : 50;
    const bar = "🟩".repeat(Math.round(upPct / 10)) + "🟥".repeat(10 - Math.round(upPct / 10));
    e.addFields({ name: `Crowd · ${cur.upCount} up / ${cur.downCount} down`, value: `${bar} ${upPct}% up · BTC window closes ${hhmm(cur.expiry)}`, inline: false });
    if (cur.state >= 2) e.addFields({ name: "On DreamDEX", value: `${usd(cur.setsMinted)} complete sets minted${cur.bookFilled > 0n ? `, ${usd(cur.bookFilled)} contracts from the book` : ""} · ${usd(cur.spent)} tUSDC in play`, inline: false });
  }
  if (l.state === 2) e.addFields({ name: "Payout", value: `${usd(l.payout)} tUSDC each`, inline: false });
  const alive = l.players.filter((p) => p.alive).map((p) => `${nameOf(p.address)}${l.state === 1 && cur && cur.state === 1 ? ` (${sideName(p.call)})` : ""}`);
  const out = l.players.filter((p) => !p.alive).map((p) => `~~${nameOf(p.address)}~~ r${p.outRound}`);
  if (alive.length) e.addFields({ name: `Alive (${alive.length})`, value: alive.slice(0, 20).join(", ").slice(0, 1000), inline: false });
  if (out.length) e.addFields({ name: `Out (${out.length})`, value: out.slice(0, 20).join(", ").slice(0, 1000), inline: false });
  e.setFooter({ text: `arena ${short(ARENA)} · Somnia Shannon · updates when you press Refresh` });
  return e;
}

function arenaButtons(l) {
  const row = new ActionRowBuilder();
  if (l.state === 0) row.addComponents(new ButtonBuilder().setCustomId(`join:${l.id}`).setLabel(`Join · ${usd(l.stake)} tUSDC`).setStyle(ButtonStyle.Success));
  if (l.state === 1) {
    row.addComponents(
      new ButtonBuilder().setCustomId(`up:${l.id}`).setLabel("▲ UP").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`down:${l.id}`).setLabel("▼ DOWN").setStyle(ButtonStyle.Danger)
    );
  }
  if (l.state === 2) row.addComponents(new ButtonBuilder().setCustomId(`claim:${l.id}`).setLabel("Claim").setStyle(ButtonStyle.Success));
  row.addComponents(new ButtonBuilder().setCustomId(`refresh:${l.id}`).setLabel("Refresh").setStyle(ButtonStyle.Secondary), new ButtonBuilder().setLabel("Open in browser").setStyle(ButtonStyle.Link).setURL(`${APP}#/lobby/${l.id}`));
  return [row];
}

async function pickArena(discordId) {
  // the lobby this user is playing, else the open one, else the newest live one
  const all = await lobbies();
  if (discordId) {
    const me = walletOf(discordId, undefined).address;
    for (const l of all.filter((x) => x.state === 1)) {
      const alive = await pub.readContract({ ...arena, functionName: "alive", args: [BigInt(l.id), me] });
      if (alive) return l.id;
    }
  }
  return (all.find((l) => l.state === 0) || all.find((l) => l.state === 1) || all[0])?.id ?? null;
}

// ------------------------------------------------------------ actions

async function doJoin(user, lobbyId) {
  const w = walletOf(user.id, user.username);
  const l = await lobby(lobbyId);
  if (l.state !== 0) throw new Error(`Arena #${lobbyId} is ${stateName[l.state]}. Use /arena to find the open one.`);
  if (l.players.some((p) => p.address.toLowerCase() === w.address.toLowerCase())) return `You are already in #${lobbyId}.`;
  const did = await ensureFunded(w, l.stake);
  await send(w, { ...arena, functionName: "join", args: [BigInt(lobbyId)] }, `join ${user.username}`);
  return `You are in **#${lobbyId} ${l.name}** with ${usd(l.stake)} tUSDC${did.length ? ` (${did.join(", ")})` : ""}. ${l.players.length + 1 >= l.minPlayers ? "The keeper starts round one on the next DreamDEX window." : `Waiting for ${l.minPlayers - l.players.length - 1} more.`}`;
}

async function doCall(user, lobbyId, side) {
  const w = walletOf(user.id, user.username);
  const l = await lobby(lobbyId);
  if (l.state !== 1 || !l.cur) throw new Error(`Arena #${lobbyId} is not live.`);
  const me = l.players.find((p) => p.address.toLowerCase() === w.address.toLowerCase());
  if (!me) throw new Error("You are not in this arena. It is already live, join the next open one with /join.");
  if (!me.alive) throw new Error(`You were eliminated in round ${me.outRound}. Spectate, or /join the next arena.`);
  if (l.cur.state !== 1) throw new Error("Calls are locked for this round. Wait for the next one.");
  if (now() >= l.cur.callDeadline) throw new Error("Calls just closed for this round.");
  await ensureFunded(w, 0n);
  await send(w, { ...arena, functionName: "call", args: [BigInt(lobbyId), side] }, `call ${side === 1 ? "UP" : "DOWN"} ${user.username}`);
  return `**${side === 1 ? "▲ UP" : "▼ DOWN"}** locked in for round ${l.cur.index}. You can change it until ${hhmm(l.cur.callDeadline)}.`;
}

async function doClaim(user, lobbyId) {
  const w = walletOf(user.id, user.username);
  const l = await lobby(lobbyId);
  if (l.state !== 2) throw new Error(`Arena #${lobbyId} is not finished.`);
  const me = l.players.find((p) => p.address.toLowerCase() === w.address.toLowerCase());
  if (!me || !me.alive) throw new Error("Only survivors of this arena can claim.");
  const claimed = await pub.readContract({ ...arena, functionName: "claimed", args: [BigInt(lobbyId), w.address] });
  if (claimed) return "Already claimed.";
  await ensureFunded(w, 0n);
  await send(w, { ...arena, functionName: "claim", args: [BigInt(lobbyId)] }, `claim ${user.username}`);
  return `Claimed **${usd(l.payout)} tUSDC** from #${lobbyId}. It is in your bot wallet (/wallet).`;
}

// ------------------------------------------------------------ interactions

client.on("interactionCreate", async (i) => {
  try {
    if (i.isChatInputCommand()) await onCommand(i);
    else if (i.isButton()) await onButton(i);
  } catch (e) {
    const msg = (e?.shortMessage || e?.message || String(e)).split("\n")[0].slice(0, 300);
    log(`interaction failed: ${msg}`);
    const payload = { content: `⚠️ ${msg}`, flags: MessageFlags.Ephemeral };
    if (i.deferred || i.replied) await i.editReply(payload).catch(() => i.followUp(payload).catch(() => {}));
    else await i.reply(payload).catch(() => {});
  }
});

async function showArena(i, lobbyId, ephemeral = false) {
  const l = await lobby(lobbyId);
  const payload = { embeds: [arenaEmbed(l)], components: arenaButtons(l) };
  if (i.deferred || i.replied) return i.editReply(payload);
  return i.reply({ ...payload, flags: ephemeral ? MessageFlags.Ephemeral : undefined });
}

async function onCommand(i) {
  const name = i.commandName;
  if (name === "arena") {
    await i.deferReply();
    const id = await pickArena(i.user.id);
    if (!id) return i.editReply("No arenas yet. The keeper opens one shortly.");
    return showArena(i, id);
  }
  if (name === "join") {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const open = await openLobby();
    if (!open) return i.editReply("No open arena right now. The keeper opens one as soon as the current game starts; try again in a minute.");
    return i.editReply(await doJoin(i.user, open.id));
  }
  if (name === "up" || name === "down") {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const id = await pickArena(i.user.id);
    return i.editReply(await doCall(i.user, id, name === "up" ? 1 : 2));
  }
  if (name === "claim") {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const me = walletOf(i.user.id, i.user.username).address;
    const done = (await lobbies(20)).filter((l) => l.state === 2);
    for (const l of done) {
      const alive = await pub.readContract({ ...arena, functionName: "alive", args: [BigInt(l.id), me] });
      const claimed = alive && (await pub.readContract({ ...arena, functionName: "claimed", args: [BigInt(l.id), me] }));
      if (alive && !claimed) return i.editReply(await doClaim(i.user, l.id));
    }
    return i.editReply("Nothing to claim. Survive an arena first.");
  }
  if (name === "wallet") {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const w = walletOf(i.user.id, i.user.username);
    const [stt, usdc] = await Promise.all([pub.getBalance({ address: w.address }), pub.readContract({ address: COLLATERAL, abi: erc20, functionName: "balanceOf", args: [w.address] })]);
    const e = new EmbedBuilder()
      .setColor(GREY)
      .setTitle("Your bot wallet (Somnia Shannon testnet)")
      .setDescription(`\`${w.address}\`\n[explorer](${EXPLORER}/address/${w.address})`)
      .addFields({ name: "STT (gas)", value: (Number(stt) / 1e18).toFixed(3), inline: true }, { name: "tUSDC", value: usd(usdc), inline: true })
      .setFooter({ text: "Testnet only. The bot signs for you; press Export to get the private key and use it in MetaMask." });
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("export").setLabel("Export private key").setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId("fund").setLabel("Top up from faucet").setStyle(ButtonStyle.Secondary));
    return i.editReply({ embeds: [e], components: [row] });
  }
  if (name === "follow") {
    if (!settings.channels.includes(i.channelId)) {
      settings.channels.push(i.channelId);
      saveSettings();
    }
    return i.reply({ content: "This channel now gets every round start, lock, settlement and elimination. Run /follow again anywhere else to add more channels.", flags: MessageFlags.Ephemeral });
  }
  if (name === "unclaimed") {
    await i.deferReply();
    const addr = i.options.getString("address") || walletOf(i.user.id, i.user.username).address;
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return i.editReply("That is not an address.");
    const u = await unclaimedOf(addr);
    const e = new EmbedBuilder()
      .setColor(0xf2b13b)
      .setTitle(`Unclaimed winnings · ${short(addr)}`)
      .setURL(`https://soy-praveen.github.io/unclaimed/#/claims/${addr}`)
      .setDescription(u.total > 0n ? `**${usd(u.total)} tUSDC** settled and never redeemed across ${u.positions} window${u.positions === 1 ? "" : "s"}. Open the claim desk to collect it in one transaction.` : "Nothing unredeemed for this wallet in the last six hours of windows.")
      .setFooter({ text: `Across the whole venue: ${usd(u.unclaimedTotal)} tUSDC unclaimed by ${u.holders} wallets · ${u.windows} windows · snapshot ${hhmm(u.generatedAt)}` });
    return i.editReply({ embeds: [e] });
  }
  if (name === "basis") {
    await i.deferReply();
    const rows = await basisNow();
    const c = (p) => (p === null ? "—" : `${(p * 100).toFixed(1)}¢`);
    const e = new EmbedBuilder()
      .setColor(0x4f46e5)
      .setTitle("DreamDEX vs Polymarket · same window, right now")
      .setURL("https://soy-praveen.github.io/basis/")
      .setDescription(rows.map((r) => `**${r.series}** closes ${hhmm(r.end)} · DreamDEX **${c(r.dream)}** · Polymarket **${c(r.poly)}** · basis ${r.dream !== null && r.poly !== null ? `${((r.dream - r.poly) * 100).toFixed(1)}¢` : "—"}`).join("\n"))
      .setFooter({ text: "Up-side mids. Take the cheaper side on DreamDEX from the Basis app." });
    return i.editReply({ embeds: [e] });
  }
}

async function onButton(i) {
  const [action, idStr] = i.customId.split(":");
  const id = Number(idStr);
  if (action === "refresh") {
    await i.deferUpdate();
    const l = await lobby(id);
    return i.editReply({ embeds: [arenaEmbed(l)], components: arenaButtons(l) });
  }
  if (action === "export") {
    const w = walletOf(i.user.id, i.user.username);
    return i.reply({ content: `Your testnet private key (never share it):\n\`${w.pk}\`\nImport it into MetaMask on Somnia Shannon to use the same wallet in the web app.`, flags: MessageFlags.Ephemeral });
  }
  if (action === "fund") {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const w = walletOf(i.user.id, i.user.username);
    const did = await ensureFunded(w, 50_000_000n);
    return i.editReply(did.length ? `Done: ${did.join(", ")}.` : "Already funded.");
  }
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  if (action === "join") return i.editReply(await doJoin(i.user, id));
  if (action === "up") return i.editReply(await doCall(i.user, id, 1));
  if (action === "down") return i.editReply(await doCall(i.user, id, 2));
  if (action === "claim") return i.editReply(await doClaim(i.user, id));
}

// ------------------------------------------------------------ channel feed

let lastBlock = null;
async function feedTick() {
  if (!settings.channels.length) return;
  const head = await pub.getBlockNumber();
  if (lastBlock === null) {
    lastBlock = head;
    return;
  }
  if (head <= lastBlock) return;
  const from = lastBlock + 1n, to = head - from > 900n ? from + 900n : head;
  const events = await arenaEvents(from, to);
  lastBlock = to;
  const posts = [];
  for (const ev of events) {
    const a = ev.args;
    const lid = Number(a.lobbyId);
    const link = `${APP}#/lobby/${lid}`;
    if (ev.name === "LobbyCreated") posts.push(new EmbedBuilder().setColor(GREY).setDescription(`🟢 **#${lid} ${a.name}** is open · stake ${usd(a.stake)} tUSDC · [join](${link}) or press Join on /arena`));
    if (ev.name === "Joined") posts.push(new EmbedBuilder().setColor(GREY).setDescription(`${nameOf(a.player)} joined **#${lid}** · pot ${usd(a.pot)} tUSDC`));
    if (ev.name === "RoundStarted") posts.push(new EmbedBuilder().setColor(NEON).setDescription(`⏱️ **#${lid} round ${a.round}** started on the BTC window closing ${hhmm(Number(a.expiry))}. Calls lock at ${hhmm(Number(a.callDeadline))}. Press ▲ UP or ▼ DOWN on /arena.`));
    if (ev.name === "RoundExecuted") posts.push(new EmbedBuilder().setColor(NEON).setDescription(`🔒 **#${lid} round ${a.round}** locked on DreamDEX · ${usd(a.setsMinted)} complete sets minted${BigInt(a.bookFilled) > 0n ? `, ${usd(a.bookFilled)} from the book` : ""} · ${usd(a.spent)} tUSDC in play · [tx](${EXPLORER}/tx/${ev.tx})`));
    if (ev.name === "Eliminated") posts.push(new EmbedBuilder().setColor(DOWN).setDescription(`💀 ${nameOf(a.player)} is out of **#${lid}** · called ${sideName(Number(a.called))}, market went ${sideName(Number(a.winner))}`));
    if (ev.name === "RoundFinalized") posts.push(new EmbedBuilder().setColor(a.voided ? GREY : Number(a.winner) === 1 ? UP : DOWN).setDescription(`${a.voided ? "⚪ voided" : Number(a.winner) === 1 ? "🟢 **UP**" : "🔴 **DOWN**"} · **#${lid} round ${a.round}** settled · ${a.eliminated} out · ${a.alive} alive · pot ${usd(a.pot)} tUSDC · [tx](${EXPLORER}/tx/${ev.tx})`));
    if (ev.name === "LobbyFinished") posts.push(new EmbedBuilder().setColor(UP).setTitle(`🏆 #${lid} finished`).setDescription(`${Number(a.survivors) === 1 ? "Last one standing" : `${a.survivors} survivors`} · ${usd(a.payoutPerSurvivor)} tUSDC each · press Claim on /arena · [open](${link})`));
  }
  if (!posts.length) return;
  for (const chId of settings.channels) {
    const ch = await client.channels.fetch(chId).catch(() => null);
    if (!ch) continue;
    for (let k = 0; k < posts.length; k += 10) await ch.send({ embeds: posts.slice(k, k + 10) }).catch((e) => log(`post failed: ${e.message}`));
  }
}

client.once("ready", () => {
  log(`discord bot online as ${client.user.tag}`);
  setInterval(() => feedTick().catch((e) => log(`feed: ${(e.shortMessage || e.message).split("\n")[0]}`)), 6000);
});
client.login(process.env.DISCORD_TOKEN);
