# DoraHacks submission text: Last Call

Paste-ready fields for https://dorahacks.io/hackathon/event-contracts. Fill the two links at the bottom once the video is uploaded.

## Project name

Last Call

## One-liner (vision)

A prediction battle royale on DreamDEX Event Contracts. Everyone stakes into one pot, every round is a live BTC or ETH window, wrong callers are eliminated by the market itself, and the last players standing split the pot.

## Description

Most DreamDEX windows on testnet expire with zero trades. The missing ingredient is not another tool, it is a reason for a crowd to show up at the same window at the same time. Last Call is that reason.

How it works:

- Players approve tUSDC and join a lobby with a fixed stake. The pot is the sum of stakes.
- Every round is one live DreamDEX window (5-minute, 15-minute or 1-hour BTC/ETH). Everyone still alive calls UP or DOWN. Calls can be changed until 90 seconds before the window closes. Silence counts as a wrong call.
- At lock, the arena contract puts the pot on DreamDEX. The matched part of UP stake and DOWN stake is minted into complete sets through the pool's `mintSet`, so the arena holds real Up and Down outcome tokens for that window. The surplus of the larger side goes to the live order book as an immediate-or-cancel `placeBinaryOrder`.
- After the window resolves, anyone settles the round. The contract reads `isResolved`, `isVoided` and `payoutNumerators` from the DreamDEX market contract, redeems the winning tokens through the `BinaryMarketsModule`, returns the collateral to the pot, and eliminates everyone who called the other side. A voided window eliminates nobody.
- Repeat until one player remains or the round limit hits. Survivors claim an equal share.

Nothing in Last Call decides an outcome. The only oracle is the DreamDEX market.

Why it matters for DreamDEX:

- Every lobby is synchronized order flow into a specific window. A 12-player lobby is 12 real positions per round, every five minutes, for as long as the game lasts.
- It is spectator-friendly. A lobby page works without a wallet, with a live crowd bar, a kill feed, and explorer links for every transaction, so a game can be streamed or shared.
- Lock, settle and start are permissionless on-chain calls. A keeper runs them, and the UI exposes the same buttons, so nobody depends on the operator. The keeper also keeps a public arena open at all times, and the app mints test tUSDC from the faucet contract with one click, so a judge can play within a minute of connecting.

It also lives in Discord. `discord/` is a bot that gives every Discord user a custodial testnet wallet on first tap (gas from the operator, tUSDC from the faucet), so `/arena` shows the live lobby as a card with Join, UP, DOWN and Claim buttons that work on the Discord phone app, `/follow` posts every round result into a channel, and `/unclaimed` and `/basis` expose the two sister projects. The bot only acts as a player; lock, settle and start stay permissionless on chain.

What is in the repo:

- `contracts/LastCall.sol`: the whole game, deployed on Somnia Shannon, talking to DreamDEX pools, markets and the module directly.
- `keeper/`: keeper that starts, locks and settles rounds on live windows; crowd bots for demos.
- `web/`: the arena UI, Vite + React + viem, MetaMask signing.
- `discord/`: the Discord bot (discord.js), custodial player wallets encrypted at rest, arena embed with buttons, channel feed.

## SDK and docs feedback (optional deliverable)

- `selfMatchingOption` on `placeBinaryOrder` means a single account cannot cross its own resting order to mint a pair. `mintSet(address yesTo, address noTo, uint256 amount)` on the pool is the right primitive for a contract that holds both sides, but its raw signature is only discoverable from the SDK bundle, not from the docs.
- `marketId` is only emitted in `MarketCreated`, not readable from the pool or market. A contract that wants to redeem has to be handed the id by whoever starts the round. A `marketId()` view would remove that trust edge.
- The `MarketCreated` events on Shannon are emitted by `0x94d963b6670ab96e78c8d0c46ca35d196d606efe`, not by the `marketCreator` address the SDK's testnet address map points at. Filtering logs by that address returns nothing.
- `marketCreatorEventsAbi` used by the official starter template is not exported from the package main entry in markets-sdk 0.29, and the `dist/` subpath is blocked by the package `exports` map. We inlined the ABI.
- Pools are recycled across windows, so any state keyed by pool address goes stale within minutes. Caching the market address and outcome ids at round start and keying by `marketId` is the pattern that worked.
- A 5-minute window is only startable in its first two and a half minutes if you need 150 seconds of lead, because windows are created at their trading start, not ahead of it. Publishing the next window one interval early would make scheduling on top of Event Contracts much easier.

## Links

- GitHub: https://github.com/soy-praveen/last-call
- Live app: https://soy-praveen.github.io/last-call/
- Arena contract (Shannon): 0x4c02a4fde4887eaf7a408a9646de34accf75a386
- Demo video: https://youtu.be/0lY8YaKRCfA

## Form fields

- Telegram handle: _yours_
- Where are you based: _yours_
- Wallet address for prize distribution: _yours_
- Discord / X handle: _yours_
