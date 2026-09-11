# Last Call

**A prediction battle royale on DreamDEX Event Contracts.**

Everyone stakes into one pot. Every round is a live DreamDEX window (BTC or ETH, 5 minutes, 15 minutes or 1 hour). Everyone still alive calls UP or DOWN before the window locks. The pot is put to work on DreamDEX, the market resolves, wrong callers are eliminated, and the last players standing split what the market left in the pot.

Built for the Somnia x DreamDEX Event Contracts Hackathon. Live on Somnia Shannon testnet.

- Web app: https://soy-praveen.github.io/last-call/
- Arena contract: `contracts/out/deployment.json` after deploy (address also in the app header)
- Demo video: https://youtu.be/0lY8YaKRCfA

## Why this exists

Most of the DreamDEX windows on testnet expire with zero trades. Tools, terminals and bots do not fix that on their own, because the missing ingredient is a reason for a crowd to show up at the same window at the same time. A battle royale is exactly that: a synchronized, social reason to be in the market every five minutes, where every call is backed by real collateral and every elimination is decided by the market itself.

Last Call turns one DreamDEX window into one round of a game, and turns a group of people into order flow.

## How a round works

1. **Join.** Players approve tUSDC and join a lobby with a fixed stake. The pot is the sum of stakes.
2. **Start.** Anyone opens a round on a live DreamDEX window. The contract checks the pool on-chain: right collateral, not finalized, market not resolved, at least 150 seconds until close.
3. **Call.** Every live player calls UP or DOWN. Calls can be changed until 90 seconds before the window closes. Staying silent counts as a wrong call.
4. **Lock.** Once calls close, anyone can lock the round. The contract computes each side's stake (pot / alive players per caller) and puts it on DreamDEX:
   - the matched part of UP stake and DOWN stake becomes complete sets through the pool's `mintSet`, so the arena holds real Up and Down outcome tokens for that window, both sides implicitly paying 0.50;
   - the surplus of the larger side goes to the live order book as an immediate-or-cancel `placeBinaryOrder` paying at most 0.55, so it trades against whoever is quoting. Anything the book cannot fill stays in the pot.
5. **Settle.** After the window closes and DreamDEX resolves it, anyone can settle the round. The contract reads `isResolved`, `isVoided` and `payoutNumerators` from the DreamDEX market contract, redeems the winning tokens through the `BinaryMarketsModule`, adds the collateral back to the pot, and eliminates everyone who called the other side. A voided window eliminates nobody. If every live player would fall, the round is a wash.
6. **Repeat** until one player remains or the round limit is reached. Survivors claim an equal share of the pot.

Nothing in Last Call decides an outcome. The only oracle is the DreamDEX market.

## What is on-chain

`contracts/LastCall.sol` is the whole game. It calls these DreamDEX surfaces directly:

| DreamDEX call | Used for |
|---|---|
| `IBinaryPool.getBinaryPoolParams()` | validating a window and reading its market, outcome token and ids |
| `IBinaryPool.marketExpiryNs()` | the window close, the call deadline and the order expiry |
| `IBinaryPool.getOrderBookParameters()` | lot and minimum size alignment |
| `IBinaryPool.mintSet(yesTo, noTo, amount)` | turning matched stake into Up + Down tokens |
| `IBinaryPool.placeBinaryOrder(...)` | sending the surplus to the book as an IOC buy |
| `IBinaryMarket.isResolved / isVoided / payoutNumerators` | reading the resolution |
| `IBinaryMarketsModule.redeem(...)` | turning winning tokens back into collateral |
| `IOutcomeToken6909.setOperator` | letting the module pull the arena's winning tokens |

Lock, settle and start are permissionless. A keeper runs them so games do not stall, and the same buttons are in the UI so anyone can push a game forward. The keeper also opens a fresh **public arena** lobby whenever no open lobby exists, so there is always a game to join, and the app header has a **Get 50 tUSDC** button that mints test collateral from the Shannon faucet contract (STT for gas comes from testnet.somnia.network).

## Play from Discord

`discord/` is a bot that turns any Discord channel into a lobby, on phone or desktop. Every Discord user gets a custodial Shannon testnet wallet on first use, topped up with STT by the operator and tUSDC from the faucet, so playing is one tap:

- `/arena`: the current arena as an embed with **Join**, **▲ UP**, **▼ DOWN**, **Claim** and **Refresh** buttons.
- `/join`, `/up`, `/down`, `/claim`: the same actions as slash commands.
- `/follow`: post every round start, lock, settlement and elimination into the channel as it happens.
- `/wallet`: address and balances, top up, export the private key to use the same wallet in MetaMask.
- `/unclaimed [address]` and `/basis`: read-only views from the two sister projects.

The bot only ever acts as a player. Lock, settle and start stay with the keeper and the permissionless buttons in the web app.

```bash
cd discord && npm install
cp .env.example .env            # DISCORD_TOKEN, DISCORD_APP_ID, optional GUILD_ID
npm run register                # slash commands
npm start
```

## Repository

```
contracts/   LastCall.sol, solc-js compile script, viem deploy script
keeper/      keeper.mjs (starts, locks, settles rounds, keeps a public arena open), crowd.mjs (bot players for demos), discover.mjs (live windows)
discord/     Discord bot: custodial player wallets, arena embed with buttons, channel feed
web/         Vite + React app, talks to Somnia through viem, MetaMask for signing
```

## Run it

Prerequisites: Node 22, a Shannon testnet key with STT and tUSDC.

```bash
npm install
cp .env.example .env            # PRIVATE_KEY, RPC_URL
npm run compile                 # contracts/out/LastCall.json
npm run deploy                  # writes contracts/out/deployment.json and web/src/deployment.json
npm run discover                # list live DreamDEX windows
SERIES=BTC/300 npm run keeper   # start, lock and settle rounds on 5-minute BTC windows

cd web && npm install && npm run dev
```

Fill an arena with bots for a demo:

```bash
node keeper/crowd.mjs fund 10                          # create and fund 10 burner wallets from the operator key
node keeper/crowd.mjs create "friday arena" 5 2 16 6   # lobby: 5 tUSDC stake, 2 to 16 players, 6 rounds
node keeper/crowd.mjs join 1 10                        # 10 bots join lobby 1
node keeper/crowd.mjs play 1                           # bots call every round with their own personalities
```

## Notes for the DreamDEX team

Things that cost time while building against Event Contracts, in case they help the docs or SDK:

- `selfMatchingOption` on `placeBinaryOrder` means a contract cannot cross its own resting order to mint a pair. `mintSet` is the right primitive for that, but it is only documented from the SDK side; the raw `mintSet(address yesTo, address noTo, uint256 amount)` signature had to be read out of the SDK bundle.
- `marketId` is only available from the `MarketCreated` log, not from the pool, so a contract that wants to redeem has to be handed the id by whoever starts the round. A `marketId()` view on the pool or market would remove that trust edge.
- Pools are recycled across windows, so any state keyed by pool address goes stale within minutes. Keying by `marketId` and caching the market address at round start is the pattern that worked.
- The `marketCreatorEventsAbi` used by the official starter template is not exported from the package's main entry in markets-sdk 0.29, and the `dist/` subpath is blocked by the package `exports` map.
- Somnia's state-creation gas pricing makes the first transaction to a fresh address noticeably more expensive; bots that fund many burner wallets should budget for it.
