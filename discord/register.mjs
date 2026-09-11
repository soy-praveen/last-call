// Register slash commands. Guild-scoped when GUILD_ID is set (instant), global otherwise.
//   node discord/register.mjs
import { REST, Routes, SlashCommandBuilder } from "discord.js";
import { config } from "dotenv";
config({ path: new URL("./.env", import.meta.url) });

const commands = [
  new SlashCommandBuilder().setName("arena").setDescription("Show the current Last Call arena with Join, UP, DOWN and Claim buttons"),
  new SlashCommandBuilder().setName("join").setDescription("Join the open public arena with your bot wallet"),
  new SlashCommandBuilder().setName("up").setDescription("Call UP in the round you are playing"),
  new SlashCommandBuilder().setName("down").setDescription("Call DOWN in the round you are playing"),
  new SlashCommandBuilder().setName("claim").setDescription("Claim your share from a finished arena"),
  new SlashCommandBuilder().setName("wallet").setDescription("Your bot wallet: address, balances, and a way to export the key"),
  new SlashCommandBuilder().setName("follow").setDescription("Post round results and eliminations into this channel"),
  new SlashCommandBuilder().setName("unclaimed").setDescription("Settled DreamDEX winnings a wallet never redeemed").addStringOption((o) => o.setName("address").setDescription("0x wallet address (defaults to your bot wallet)")),
  new SlashCommandBuilder().setName("basis").setDescription("DreamDEX vs Polymarket, same window, right now"),
].map((c) => c.toJSON());

const rest = new REST().setToken(process.env.DISCORD_TOKEN);
const appId = process.env.DISCORD_APP_ID;
if (process.env.GUILD_ID) {
  await rest.put(Routes.applicationGuildCommands(appId, process.env.GUILD_ID), { body: commands });
  console.log(`registered ${commands.length} guild commands`);
} else {
  await rest.put(Routes.applicationCommands(appId), { body: commands });
  console.log(`registered ${commands.length} global commands (may take up to an hour to appear)`);
}
