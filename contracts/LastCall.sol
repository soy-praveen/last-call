// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// ---------------------------------------------------------------------------
/// DreamDEX Event Contracts, the slice of the on-chain surface Last Call uses.
/// Verified against the markets-sdk ABIs (v0.29) and the Somnia Shannon testnet.
/// ---------------------------------------------------------------------------

struct BinaryPoolParams {
    address collateralToken;
    address market;
    address outcomeToken;
    uint256 yesId;
    uint256 noId;
    uint256 oneCollateral;
    uint256 setBacking;
    address feeRecipient;
    uint256 makerFeeBpsTimes1k;
    uint256 takerFeeBpsTimes1k;
    uint256 maxBuilderFeeBpsTimes1k;
    uint256 settlementFeeBpsTimes1k;
    address settlement;
    uint64 marketNonce;
    bool finalized;
}

struct OrderBookParams {
    uint256 tickSize;
    uint256 minQuantity;
    uint256 lotSize;
}

interface IBinaryPool {
    function placeBinaryOrder(
        uint8 kind,
        uint256 price,
        uint256 quantity,
        uint64 expireTimestampNs,
        uint8 orderType,
        uint8 selfMatchingOption,
        address builder,
        uint96 builderFeeBpsTimes1k,
        uint64 userData
    ) external payable returns (bool success, uint128 id);

    function mintSet(address yesTo, address noTo, uint256 amount) external;
    function getBinaryPoolParams() external view returns (BinaryPoolParams memory);
    function getOrderBookParameters() external view returns (OrderBookParams memory);
    function marketExpiryNs() external view returns (uint64);
}

interface IBinaryMarket {
    function isResolved() external view returns (bool);
    function isVoided() external view returns (bool);
    function payoutNumerators() external view returns (uint256[] memory);
    function expiry() external view returns (uint64);
}

interface IBinaryMarketsModule {
    function redeem(uint32 operatorId, bytes32 venueId, bytes32 marketId, uint8 outcomeIdx, uint256 amount) external;
}

interface IOutcomeToken6909 {
    function balanceOf(address owner, uint256 id) external view returns (uint256);
    function isOperator(address owner, address spender) external view returns (bool);
    function setOperator(address spender, bool approved) external returns (bool);
}

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title Last Call
/// @notice A prediction battle royale on DreamDEX Event Contracts.
///
/// Players stake into a shared pot. Every round is one live DreamDEX window
/// (BTC or ETH, 15 minutes or 1 hour). Everyone still alive calls UP or DOWN
/// before the window locks. The pot is then put to work on DreamDEX:
///
///   * the matched part of the crowd (UP stake vs DOWN stake) is turned into
///     complete sets through the pool's mintSet, so the arena holds real Up and
///     Down outcome tokens for that window;
///   * the unmatched surplus is sent to the live order book as an immediate-or-
///     cancel buy of the majority side, so it trades against whoever is quoting.
///
/// When the window resolves, the winning side is read straight from the
/// DreamDEX market contract. Nobody in this contract decides an outcome. Wrong
/// callers (and anyone who stayed silent) are eliminated, winning tokens are
/// redeemed through the DreamDEX module, and the pot rolls into the next round.
/// The last players standing split what the market left in the pot.
contract LastCall {
    // ------------------------------------------------------------------ types

    enum Side { None, Up, Down }
    enum LobbyState { Open, Live, Finished, Cancelled }
    enum RoundState { None, Calling, Executed, Finalized }

    struct Lobby {
        address creator;
        string name;
        uint256 stake;          // collateral per player, raw units
        uint8 minPlayers;
        uint8 maxPlayers;
        uint8 maxRounds;
        LobbyState state;
        uint256 pot;            // collateral held for this lobby, raw units
        uint256 alive;          // players still in
        uint256 roundCount;     // rounds started so far
        uint256 payoutPerSurvivor;
        uint64 createdAt;
        uint64 createdBlock;
    }

    struct Round {
        address pool;
        address market;
        address outcomeToken;
        bytes32 marketId;
        uint256 yesId;
        uint256 noId;
        uint64 expiry;          // window close, seconds
        uint64 callDeadline;    // calls accepted until this time
        RoundState state;
        uint256 upCount;
        uint256 downCount;
        uint256 upStake;        // collateral backing UP callers this round
        uint256 downStake;      // collateral backing DOWN callers this round
        uint256 setsMinted;     // complete sets minted (raw contracts)
        uint256 bookFilled;     // extra contracts bought from the book
        Side bookSide;          // which side the surplus went to
        uint256 spent;          // collateral that left the pot for this round
        uint256 returned;       // collateral that came back on finalize
        Side winner;            // Up / Down, None if voided
        bool voided;
        uint256 eliminated;
    }

    // ---------------------------------------------------------------- storage

    IERC20 public immutable collateral;
    IBinaryMarketsModule public immutable module;
    address public owner;

    uint64 public constant MIN_LEAD = 150;      // a round needs at least this long before lock
    uint64 public constant LOCK_BEFORE = 90;    // calls close this many seconds before expiry
    uint8 public constant MAX_PLAYERS = 64;

    uint256 public lobbyCount;
    mapping(uint256 => Lobby) internal lobbies;
    mapping(uint256 => address[]) internal players;
    mapping(uint256 => mapping(address => bool)) public joined;
    mapping(uint256 => mapping(address => bool)) public alive;
    mapping(uint256 => mapping(address => bool)) public claimed;
    mapping(uint256 => mapping(uint256 => Round)) internal rounds;                       // lobby -> round index -> round
    mapping(uint256 => mapping(uint256 => mapping(address => Side))) public calls;      // lobby -> round -> player -> call
    mapping(uint256 => mapping(address => uint256)) public eliminatedInRound;             // 0 = still alive

    // ----------------------------------------------------------------- events

    event LobbyCreated(uint256 indexed lobbyId, address indexed creator, string name, uint256 stake, uint8 minPlayers, uint8 maxPlayers, uint8 maxRounds);
    event Joined(uint256 indexed lobbyId, address indexed player, uint256 players, uint256 pot);
    event Left(uint256 indexed lobbyId, address indexed player);
    event LobbyCancelled(uint256 indexed lobbyId);
    event RoundStarted(uint256 indexed lobbyId, uint256 indexed round, address pool, address market, bytes32 marketId, uint64 expiry, uint64 callDeadline);
    event Called(uint256 indexed lobbyId, uint256 indexed round, address indexed player, Side side);
    event RoundExecuted(uint256 indexed lobbyId, uint256 indexed round, uint256 setsMinted, Side bookSide, uint256 bookFilled, uint256 spent);
    event RoundFinalized(uint256 indexed lobbyId, uint256 indexed round, Side winner, bool voided, uint256 returned, uint256 eliminated, uint256 alive, uint256 pot);
    event Eliminated(uint256 indexed lobbyId, uint256 indexed round, address indexed player, Side called, Side winner);
    event LobbyFinished(uint256 indexed lobbyId, uint256 survivors, uint256 pot, uint256 payoutPerSurvivor);
    event Claimed(uint256 indexed lobbyId, address indexed player, uint256 amount);

    // ----------------------------------------------------------------- errors

    error BadState();
    error NotAllowed();
    error AlreadyJoined();
    error LobbyFull();
    error NotEnoughPlayers();
    error NotAlive();
    error CallsClosed();
    error TooEarly();
    error TooLate();
    error BadMarket();
    error NothingToClaim();

    constructor(address collateral_, address module_) {
        collateral = IERC20(collateral_);
        module = IBinaryMarketsModule(module_);
        owner = msg.sender;
    }

    // ------------------------------------------------------------------ views

    function getLobby(uint256 lobbyId) external view returns (Lobby memory) {
        return lobbies[lobbyId];
    }

    function getPlayers(uint256 lobbyId) external view returns (address[] memory) {
        return players[lobbyId];
    }

    function getRound(uint256 lobbyId, uint256 round) external view returns (Round memory) {
        return rounds[lobbyId][round];
    }

    /// @notice Everything a UI needs for one player in one lobby.
    function playerStatus(uint256 lobbyId, address player)
        external
        view
        returns (bool isJoined, bool isAlive, uint256 outRound, Side currentCall)
    {
        Lobby storage l = lobbies[lobbyId];
        isJoined = joined[lobbyId][player];
        isAlive = alive[lobbyId][player];
        outRound = eliminatedInRound[lobbyId][player];
        currentCall = l.roundCount == 0 ? Side.None : calls[lobbyId][l.roundCount][player];
    }


    /// @notice One call for a UI: every player with their alive flag, current
    ///         call, and the round they fell in (0 = still in).
    function getPlayerStates(uint256 lobbyId)
        external
        view
        returns (address[] memory addrs, bool[] memory isAlive, Side[] memory currentCall, uint256[] memory outRound)
    {
        Lobby storage l = lobbies[lobbyId];
        address[] storage ps = players[lobbyId];
        uint256 n = ps.length;
        addrs = new address[](n);
        isAlive = new bool[](n);
        currentCall = new Side[](n);
        outRound = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            address a = ps[i];
            addrs[i] = a;
            isAlive[i] = alive[lobbyId][a];
            currentCall[i] = l.roundCount == 0 ? Side.None : calls[lobbyId][l.roundCount][a];
            outRound[i] = eliminatedInRound[lobbyId][a];
        }
    }

    /// @notice Every round of a lobby, for history views.
    function getRounds(uint256 lobbyId) external view returns (Round[] memory out) {
        uint256 n = lobbies[lobbyId].roundCount;
        out = new Round[](n);
        for (uint256 i = 0; i < n; i++) out[i] = rounds[lobbyId][i + 1];
    }

    // ------------------------------------------------------------------ lobby

    function createLobby(string calldata name, uint256 stake, uint8 minPlayers, uint8 maxPlayers, uint8 maxRounds)
        external
        returns (uint256 lobbyId)
    {
        if (stake == 0 || minPlayers < 2 || maxPlayers < minPlayers || maxPlayers > MAX_PLAYERS || maxRounds == 0) revert BadState();
        lobbyId = ++lobbyCount;
        Lobby storage l = lobbies[lobbyId];
        l.creator = msg.sender;
        l.name = name;
        l.stake = stake;
        l.minPlayers = minPlayers;
        l.maxPlayers = maxPlayers;
        l.maxRounds = maxRounds;
        l.state = LobbyState.Open;
        l.createdAt = uint64(block.timestamp);
        l.createdBlock = uint64(block.number);
        emit LobbyCreated(lobbyId, msg.sender, name, stake, minPlayers, maxPlayers, maxRounds);
    }

    function join(uint256 lobbyId) external {
        Lobby storage l = lobbies[lobbyId];
        if (l.state != LobbyState.Open) revert BadState();
        if (joined[lobbyId][msg.sender]) revert AlreadyJoined();
        if (players[lobbyId].length >= l.maxPlayers) revert LobbyFull();
        if (!collateral.transferFrom(msg.sender, address(this), l.stake)) revert BadState();
        joined[lobbyId][msg.sender] = true;
        alive[lobbyId][msg.sender] = true;
        players[lobbyId].push(msg.sender);
        l.alive += 1;
        l.pot += l.stake;
        emit Joined(lobbyId, msg.sender, players[lobbyId].length, l.pot);
    }

    /// @notice Walk away before the first round starts; the stake comes back.
    function leaveLobby(uint256 lobbyId) external {
        Lobby storage l = lobbies[lobbyId];
        if (l.state != LobbyState.Open) revert BadState();
        if (!joined[lobbyId][msg.sender]) revert NotAllowed();
        joined[lobbyId][msg.sender] = false;
        alive[lobbyId][msg.sender] = false;
        address[] storage ps = players[lobbyId];
        for (uint256 i = 0; i < ps.length; i++) {
            if (ps[i] == msg.sender) {
                ps[i] = ps[ps.length - 1];
                ps.pop();
                break;
            }
        }
        l.alive -= 1;
        l.pot -= l.stake;
        collateral.transfer(msg.sender, l.stake);
        emit Left(lobbyId, msg.sender);
    }

    /// @notice The creator can cancel an unstarted lobby; everyone is refunded.
    function cancelLobby(uint256 lobbyId) external {
        Lobby storage l = lobbies[lobbyId];
        if (l.state != LobbyState.Open) revert BadState();
        if (msg.sender != l.creator && msg.sender != owner) revert NotAllowed();
        l.state = LobbyState.Cancelled;
        address[] storage ps = players[lobbyId];
        for (uint256 i = 0; i < ps.length; i++) {
            alive[lobbyId][ps[i]] = false;
            collateral.transfer(ps[i], l.stake);
        }
        l.pot = 0;
        l.alive = 0;
        emit LobbyCancelled(lobbyId);
    }

    // ----------------------------------------------------------------- rounds

    /// @notice Open a round on a live DreamDEX window. Anyone can call it: the
    ///         pool is validated on-chain (right collateral, not finalized, not
    ///         resolved, enough time left). `marketId` is the id from the
    ///         MarketCreated log; it is only used to redeem through the module.
    function startRound(uint256 lobbyId, address pool, bytes32 marketId) external {
        Lobby storage l = lobbies[lobbyId];
        if (l.state == LobbyState.Open) {
            if (players[lobbyId].length < l.minPlayers) revert NotEnoughPlayers();
            l.state = LobbyState.Live;
        } else if (l.state != LobbyState.Live) {
            revert BadState();
        }
        if (l.roundCount > 0 && rounds[lobbyId][l.roundCount].state != RoundState.Finalized) revert BadState();
        if (l.roundCount >= l.maxRounds) revert BadState();

        BinaryPoolParams memory p = IBinaryPool(pool).getBinaryPoolParams();
        if (p.collateralToken != address(collateral) || p.finalized || p.market == address(0)) revert BadMarket();
        IBinaryMarket m = IBinaryMarket(p.market);
        if (m.isResolved() || m.isVoided()) revert BadMarket();
        uint64 expiry = uint64(IBinaryPool(pool).marketExpiryNs() / 1e9);
        if (expiry < block.timestamp + MIN_LEAD) revert BadMarket();

        uint256 idx = ++l.roundCount;
        Round storage r = rounds[lobbyId][idx];
        r.pool = pool;
        r.market = p.market;
        r.outcomeToken = p.outcomeToken;
        r.marketId = marketId;
        r.yesId = p.yesId;
        r.noId = p.noId;
        r.expiry = expiry;
        r.callDeadline = expiry - LOCK_BEFORE;
        r.state = RoundState.Calling;
        emit RoundStarted(lobbyId, idx, pool, p.market, marketId, expiry, r.callDeadline);
    }

    /// @notice Make your call for the current round. You can change it until lock.
    function call(uint256 lobbyId, Side side) external {
        if (side == Side.None) revert BadState();
        Lobby storage l = lobbies[lobbyId];
        if (l.state != LobbyState.Live) revert BadState();
        if (!alive[lobbyId][msg.sender]) revert NotAlive();
        uint256 idx = l.roundCount;
        Round storage r = rounds[lobbyId][idx];
        if (r.state != RoundState.Calling) revert BadState();
        if (block.timestamp >= r.callDeadline) revert CallsClosed();
        Side prev = calls[lobbyId][idx][msg.sender];
        if (prev == side) return;
        if (prev == Side.Up) r.upCount -= 1;
        if (prev == Side.Down) r.downCount -= 1;
        if (side == Side.Up) r.upCount += 1; else r.downCount += 1;
        calls[lobbyId][idx][msg.sender] = side;
        emit Called(lobbyId, idx, msg.sender, side);
    }

    /// @notice Lock the round and put the pot on DreamDEX. Anyone can call it
    ///         once calls are closed and while the window is still trading.
    function executeRound(uint256 lobbyId) external {
        Lobby storage l = lobbies[lobbyId];
        if (l.state != LobbyState.Live) revert BadState();
        uint256 idx = l.roundCount;
        Round storage r = rounds[lobbyId][idx];
        if (r.state != RoundState.Calling) revert BadState();
        if (block.timestamp < r.callDeadline) revert TooEarly();
        if (block.timestamp >= r.expiry - 15) revert TooLate();

        r.state = RoundState.Executed;
        uint256 callers = r.upCount + r.downCount;
        if (callers == 0) {
            emit RoundExecuted(lobbyId, idx, 0, Side.None, 0, 0);
            return;
        }

        // Each live player owns pot / alive. Only callers put their share to work.
        uint256 share = l.pot / l.alive;
        r.upStake = share * r.upCount;
        r.downStake = share * r.downCount;

        IBinaryPool pool = IBinaryPool(r.pool);
        BinaryPoolParams memory p = pool.getBinaryPoolParams();
        OrderBookParams memory ob = pool.getOrderBookParameters();
        _approveIfNeeded(r.pool, r.upStake + r.downStake);

        uint256 before = collateral.balanceOf(address(this));

        // 1. Matched stake becomes complete sets: UP callers fund half of every
        //    set and get its Up token, DOWN callers fund the other half and get
        //    its Down token. Both sides are implicitly buying at 0.50.
        uint256 matched = r.upStake < r.downStake ? r.upStake : r.downStake;
        uint256 sets = _alignDown(2 * matched, ob.lotSize);
        if (sets >= ob.minQuantity && sets > 0) {
            // amount is in contracts; one set costs oneCollateral per contract.
            pool.mintSet(address(this), address(this), sets);
            r.setsMinted = sets;
        }

        // 2. The surplus of the larger side goes to the live book as an IOC buy,
        //    paying up to 0.55. Whatever the book cannot fill stays in the pot.
        uint256 surplus = r.upStake > r.downStake ? r.upStake - r.downStake : r.downStake - r.upStake;
        if (surplus > 0) {
            Side side = r.upStake > r.downStake ? Side.Up : Side.Down;
            uint256 cap = (p.oneCollateral * 55) / 100;                 // 0.55 on the side we buy
            uint256 yesPrice = side == Side.Up ? cap : p.oneCollateral - cap;
            uint256 qty = _alignDown((surplus * p.oneCollateral) / cap, ob.lotSize);
            if (qty >= ob.minQuantity && qty > 0) {
                uint256 id = side == Side.Up ? r.yesId : r.noId;
                uint256 held = IOutcomeToken6909(r.outcomeToken).balanceOf(address(this), id);
                uint64 exp = pool.marketExpiryNs();
                try pool.placeBinaryOrder(side == Side.Up ? 0 : 2, yesPrice, qty, exp, 2, 0, address(0), 0, 0) returns (bool, uint128) {
                    uint256 got = IOutcomeToken6909(r.outcomeToken).balanceOf(address(this), id) - held;
                    r.bookFilled = got;
                    r.bookSide = side;
                } catch {
                    // An empty or locked book must never block the game.
                }
            }
        }

        uint256 afterBal = collateral.balanceOf(address(this));
        r.spent = before - afterBal;
        l.pot -= r.spent;
        emit RoundExecuted(lobbyId, idx, r.setsMinted, r.bookSide, r.bookFilled, r.spent);
    }

    /// @notice Settle the round from the DreamDEX market's own resolution,
    ///         redeem the winning tokens, and eliminate the wrong callers.
    function finalizeRound(uint256 lobbyId) external {
        Lobby storage l = lobbies[lobbyId];
        if (l.state != LobbyState.Live) revert BadState();
        uint256 idx = l.roundCount;
        Round storage r = rounds[lobbyId][idx];
        if (r.state != RoundState.Executed) {
            // A round nobody executed in time is settled as a wash once the window closed.
            if (r.state == RoundState.Calling && block.timestamp >= r.expiry) {
                r.state = RoundState.Executed;
            } else {
                revert BadState();
            }
        }
        IBinaryMarket m = IBinaryMarket(r.market);
        bool resolved = m.isResolved();
        bool voided = m.isVoided();
        if (!resolved && !voided) revert TooEarly();

        Side winner = Side.None;
        if (resolved) {
            uint256[] memory payouts = m.payoutNumerators();
            winner = payouts.length > 0 && payouts[0] > 0 ? Side.Up : Side.Down;
        }
        r.winner = winner;
        r.voided = voided;

        // Redeem through the module. Voided markets pay both sides.
        uint256 before = collateral.balanceOf(address(this));
        _ensureOperator(r.outcomeToken);
        uint256 upHeld = r.setsMinted + (r.bookSide == Side.Up ? r.bookFilled : 0);
        uint256 downHeld = r.setsMinted + (r.bookSide == Side.Down ? r.bookFilled : 0);
        if (voided) {
            if (upHeld > 0) _redeem(r, 0, upHeld);
            if (downHeld > 0) _redeem(r, 1, downHeld);
        } else if (winner == Side.Up && upHeld > 0) {
            _redeem(r, 0, upHeld);
        } else if (winner == Side.Down && downHeld > 0) {
            _redeem(r, 1, downHeld);
        }
        r.returned = collateral.balanceOf(address(this)) - before;
        l.pot += r.returned;

        // Eliminations. A voided window eliminates nobody. If every live player
        // would fall, the round is a wash and everyone stays.
        uint256 eliminated = 0;
        if (!voided) {
            address[] storage ps = players[lobbyId];
            uint256 wouldFall = 0;
            for (uint256 i = 0; i < ps.length; i++) {
                if (alive[lobbyId][ps[i]] && calls[lobbyId][idx][ps[i]] != winner) wouldFall++;
            }
            if (wouldFall < l.alive) {
                for (uint256 i = 0; i < ps.length; i++) {
                    address pl = ps[i];
                    if (!alive[lobbyId][pl]) continue;
                    Side c = calls[lobbyId][idx][pl];
                    if (c != winner) {
                        alive[lobbyId][pl] = false;
                        eliminatedInRound[lobbyId][pl] = idx;
                        eliminated++;
                        emit Eliminated(lobbyId, idx, pl, c, winner);
                    }
                }
                l.alive -= eliminated;
            }
        }
        r.eliminated = eliminated;
        r.state = RoundState.Finalized;
        emit RoundFinalized(lobbyId, idx, winner, voided, r.returned, eliminated, l.alive, l.pot);

        if (l.alive <= 1 || l.roundCount >= l.maxRounds) {
            _finish(lobbyId);
        }
    }

    /// @notice Survivors collect their share once the lobby is finished.
    function claim(uint256 lobbyId) external {
        Lobby storage l = lobbies[lobbyId];
        if (l.state != LobbyState.Finished) revert BadState();
        if (!alive[lobbyId][msg.sender] || claimed[lobbyId][msg.sender]) revert NothingToClaim();
        claimed[lobbyId][msg.sender] = true;
        uint256 amount = l.payoutPerSurvivor;
        l.pot -= amount;
        collateral.transfer(msg.sender, amount);
        emit Claimed(lobbyId, msg.sender, amount);
    }

    // -------------------------------------------------------------- internals

    function _finish(uint256 lobbyId) internal {
        Lobby storage l = lobbies[lobbyId];
        l.state = LobbyState.Finished;
        l.payoutPerSurvivor = l.alive == 0 ? 0 : l.pot / l.alive;
        emit LobbyFinished(lobbyId, l.alive, l.pot, l.payoutPerSurvivor);
    }

    function _redeem(Round storage r, uint8 outcomeIdx, uint256 amount) internal {
        uint256 id = outcomeIdx == 0 ? r.yesId : r.noId;
        uint256 held = IOutcomeToken6909(r.outcomeToken).balanceOf(address(this), id);
        if (held < amount) amount = held;
        if (amount == 0) return;
        module.redeem(0, bytes32(0), r.marketId, outcomeIdx, amount);
    }

    function _ensureOperator(address outcomeToken) internal {
        IOutcomeToken6909 t = IOutcomeToken6909(outcomeToken);
        if (!t.isOperator(address(this), address(module))) t.setOperator(address(module), true);
    }

    function _approveIfNeeded(address pool, uint256 amount) internal {
        if (collateral.allowance(address(this), pool) < amount) collateral.approve(pool, type(uint256).max);
    }

    function _alignDown(uint256 qty, uint256 lot) internal pure returns (uint256) {
        if (lot == 0) return qty;
        return (qty / lot) * lot;
    }

    // ------------------------------------------------------------- emergency

    /// @notice If a redeem ever fails because the supplied marketId was wrong,
    ///         the owner can retry it with the right ids and return the
    ///         collateral to the lobby's pot. Never touches player stakes.
    function rescueRedeem(uint256 lobbyId, uint256 round, uint32 operatorId, bytes32 venueId, bytes32 marketId, uint8 outcomeIdx, uint256 amount) external {
        if (msg.sender != owner) revert NotAllowed();
        Round storage r = rounds[lobbyId][round];
        uint256 before = collateral.balanceOf(address(this));
        _ensureOperator(r.outcomeToken);
        module.redeem(operatorId, venueId, marketId, outcomeIdx, amount);
        uint256 got = collateral.balanceOf(address(this)) - before;
        lobbies[lobbyId].pot += got;
        r.returned += got;
    }
}
