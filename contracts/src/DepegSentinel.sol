// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {ISystemContract} from "@reactive/src/interfaces/ISystemContract.sol";
import {IReactive} from "@reactive/src/interfaces/IReactive.sol";
import {AbstractReactive} from "@reactive/src/base/AbstractReactive.sol";

/// @title DepegSentinel
/// @notice Reactive contract (Lasna) that watches a stablecoin pool's `Sync` events,
///         runs a depeg state machine and fans out to two destinations:
///           - PolicyVault (insurance): `onDepeg` once per epoch, `onRecover` on recovery
///           - PegKeeper (defense):     `defend` rounds, rate-limited by origin blocks
///
///         NORMAL --price < watch--> WATCH --N consecutive < watch--> DEPEGGED --price >= recover--> NORMAL
///                 <--price >= watch--
///
/// @dev `react()` never reverts on bad input because reverted reactive txs are still billed.
contract DepegSentinel is AbstractReactive {
    enum Status {
        NORMAL,
        WATCH,
        DEPEGGED
    }

    error NotOwner();
    error InvalidConfig();

    /// keccak256("Sync(uint112,uint112)"), identical to Uniswap V2.
    uint256 public constant SYNC_TOPIC_0 = uint256(keccak256("Sync(uint112,uint112)"));
    uint256 private constant BPS_TO_E18 = 1e14;
    uint64 public constant VAULT_GAS_LIMIT = 1_000_000;
    uint64 public constant KEEPER_GAS_LIMIT = 400_000;

    address public immutable owner;
    uint256 public immutable originChainId;
    address public immutable pair;
    bool public immutable stableIsToken0;
    uint256 public immutable watchPriceE18;
    uint256 public immutable recoverPriceE18;
    uint256 public immutable confirmations;
    uint256 public immutable keeperCooldownBlocks;
    uint256 public immutable maxKeeperRounds;

    uint256 public vaultChainId;
    address public vault;
    uint256 public keeperChainId;
    address public keeper;

    Status public status;
    uint256 public epoch;
    uint256 public belowCount;
    uint256 public keeperRounds;
    uint256 public lastKeeperBlock;
    uint256 public lastPriceE18;
    uint256 public lastOriginBlock;

    event DestinationsSet(uint256 vaultChainId, address vault, uint256 keeperChainId, address keeper);
    event PriceObserved(uint256 priceE18, uint256 originBlock, uint256 originTxHash, Status status);
    event StatusChanged(
        uint256 indexed epoch, Status from, Status to, uint256 priceE18, uint256 originBlock, uint256 originTxHash
    );
    event KeeperRequested(uint256 indexed epoch, uint256 round, uint256 priceE18, uint256 originBlock);

    /// @param watchBps_ price (bps of parity) below which the pool is suspicious, e.g. 9700
    /// @param recoverBps_ price at which a depeg is considered over, e.g. 9900 (hysteresis)
    /// @param confirmations_ consecutive below-watch updates that confirm a depeg, e.g. 3
    /// @param keeperCooldownBlocks_ minimum origin blocks between keeper rounds
    /// @param maxKeeperRounds_ maximum keeper rounds per epoch
    constructor(
        uint256 originChainId_,
        address pair_,
        bool stableIsToken0_,
        uint256 watchBps_,
        uint256 recoverBps_,
        uint256 confirmations_,
        uint256 keeperCooldownBlocks_,
        uint256 maxKeeperRounds_
    ) payable {
        if (watchBps_ == 0 || watchBps_ > recoverBps_ || recoverBps_ > 10_000 || confirmations_ == 0) {
            revert InvalidConfig();
        }
        owner = msg.sender;
        originChainId = originChainId_;
        pair = pair_;
        stableIsToken0 = stableIsToken0_;
        watchPriceE18 = watchBps_ * BPS_TO_E18;
        recoverPriceE18 = recoverBps_ * BPS_TO_E18;
        confirmations = confirmations_;
        keeperCooldownBlocks = keeperCooldownBlocks_;
        maxKeeperRounds = maxKeeperRounds_;

        SYSTEM.subscribe(originChainId_, pair_, SYNC_TOPIC_0, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
    }

    /// @notice Destinations are set after deployment because callback contracts need this
    ///         contract's address at construction. A zero address disables that leg.
    function setDestinations(uint256 vaultChainId_, address vault_, uint256 keeperChainId_, address keeper_) external {
        if (msg.sender != owner) revert NotOwner();
        vaultChainId = vaultChainId_;
        vault = vault_;
        keeperChainId = keeperChainId_;
        keeper = keeper_;
        emit DestinationsSet(vaultChainId_, vault_, keeperChainId_, keeper_);
    }

    /// @notice Settles outstanding debt from this contract's own balance.
    function coverDebt() external {
        _coverDebt();
    }

    /// @inheritdoc IReactive
    function react(LogRecord calldata log_) external onlySystem {
        if (
            log_.chainId != originChainId || log_.contractAddress != pair || log_.topic0 != SYNC_TOPIC_0
                || log_.data.length != 64
        ) return;

        // Decode as uint256 so malformed data can never make react() revert.
        (uint256 r0, uint256 r1) = abi.decode(log_.data, (uint256, uint256));
        (uint256 rStable, uint256 rQuote) = stableIsToken0 ? (r0, r1) : (r1, r0);
        if (rStable == 0 || rQuote > type(uint112).max) return;

        uint256 price = rQuote * 1e18 / rStable;
        lastPriceE18 = price;
        lastOriginBlock = log_.blockNumber;

        Status current = status;
        if (current == Status.NORMAL) {
            if (price < watchPriceE18) {
                belowCount = 1;
                _setStatus(Status.WATCH, price, log_);
                if (confirmations == 1) _enterDepeg(price, log_);
            }
        } else if (current == Status.WATCH) {
            if (price < watchPriceE18) {
                uint256 n = belowCount + 1;
                belowCount = n;
                if (n >= confirmations) _enterDepeg(price, log_);
            } else {
                belowCount = 0;
                _setStatus(Status.NORMAL, price, log_);
            }
        } else {
            if (price >= recoverPriceE18) {
                belowCount = 0;
                _setStatus(Status.NORMAL, price, log_);
                _requestVault("onRecover(address,uint256,uint256,uint256,uint256)", price, log_);
            } else {
                _maybeDefend(price, log_);
            }
        }

        emit PriceObserved(price, log_.blockNumber, log_.txHash, status);
    }

    function _enterDepeg(uint256 price, LogRecord calldata log_) internal {
        epoch += 1;
        keeperRounds = 0;
        _setStatus(Status.DEPEGGED, price, log_);
        _requestVault("onDepeg(address,uint256,uint256,uint256,uint256)", price, log_);
        _maybeDefend(price, log_);
    }

    /// @dev The keeper's own swap emits `Sync`, so rounds are capped and spaced out to
    ///      avoid a feedback loop.
    function _maybeDefend(uint256 price, LogRecord calldata log_) internal {
        if (keeper == address(0)) return;
        uint256 rounds = keeperRounds;
        if (rounds >= maxKeeperRounds) return;
        if (rounds != 0 && log_.blockNumber < lastKeeperBlock + keeperCooldownBlocks) return;

        rounds += 1;
        keeperRounds = rounds;
        lastKeeperBlock = log_.blockNumber;

        bytes memory payload = abi.encodeWithSignature(
            "defend(address,uint256,uint256,uint256,uint256,uint256)",
            address(0),
            epoch,
            rounds,
            price,
            log_.blockNumber,
            log_.txHash
        );
        _request(keeperChainId, keeper, KEEPER_GAS_LIMIT, payload);
        emit KeeperRequested(epoch, rounds, price, log_.blockNumber);
    }

    function _requestVault(string memory signature, uint256 price, LogRecord calldata log_) internal {
        if (vault == address(0)) return;
        bytes memory payload =
            abi.encodeWithSignature(signature, address(0), epoch, price, log_.blockNumber, log_.txHash);
        _request(vaultChainId, vault, VAULT_GAS_LIMIT, payload);
    }

    function _setStatus(Status to, uint256 price, LogRecord calldata log_) internal {
        Status from = status;
        status = to;
        emit StatusChanged(epoch, from, to, price, log_.blockNumber, log_.txHash);
    }

    function _request(uint256 chainId_, address recipient_, uint64 gasLimit_, bytes memory payload_) internal {
        SYSTEM.requestCallbackV_1_0(
            ISystemContract.CallbackConfiguration_V_1_0({
                chainId: chainId_, recipient: recipient_, gasLimit: gasLimit_, payload: payload_
            })
        );
    }
}
