// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IPayable} from "@reactive/src/interfaces/IPayable.sol";
import {AbstractCallback} from "@reactive/src/base/AbstractCallback.sol";
import {IERC20Minimal} from "./interfaces/IERC20Minimal.sol";

/// @title PolicyVault
/// @notice Parametric depeg insurance on the destination chain. Underwriters pool capital,
///         buyers pay a flat premium for coverage over a fixed term, and a depeg confirmed
///         by DepegSentinel pays every active policy in full, with no claim form.
///
///         - Fully collateralized: total active coverage never exceeds pool assets.
///         - `onDepeg` pushes up to MAX_PUSH_PAYOUTS payouts inside the callback; anyone can
///           settle the rest with `claim` / `processQueue`.
///         - Sales pause while a depeg is active (no buying insurance on a burning house).
///         - Callbacks are idempotent per epoch and tolerate out-of-order delivery.
contract PolicyVault is AbstractCallback {
    struct Policy {
        address holder;
        uint64 start;
        uint64 expiry;
        bool settled;
        uint256 coverage;
    }

    error ZeroAmount();
    error ZeroShares();
    error DepegActive();
    error InsufficientCapacity(uint256 requested, uint256 available);
    error InsufficientFreeAssets(uint256 requested, uint256 available);
    error InsufficientShares(uint256 balance, uint256 needed);
    error NotEligible(uint256 policyId);
    error InvalidConfig();
    error TokenTransferFailed();

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_PUSH_PAYOUTS = 8;

    IERC20Minimal public immutable asset;
    uint256 public immutable premiumBps;
    uint256 public immutable term;
    uint256 public immutable warmup;

    uint256 public totalShares;
    mapping(address => uint256) public sharesOf;
    uint256 public lockedCoverage;

    uint256 public nextPolicyId = 1;
    mapping(uint256 => Policy) public policies;
    uint256[] internal _openIds;
    mapping(uint256 => uint256) internal _openIndexPlusOne;

    uint256 public lastDepegEpoch;
    uint256 public recoveredEpoch;
    mapping(uint256 => uint64) public depegTime;

    event Deposited(address indexed underwriter, uint256 assets, uint256 shares);
    event Withdrawn(address indexed underwriter, uint256 assets, uint256 shares);
    event PolicyBought(
        uint256 indexed id, address indexed holder, uint256 coverage, uint256 premium, uint64 start, uint64 expiry
    );
    event PaidOut(uint256 indexed id, address indexed holder, uint256 amount, uint256 indexed epoch);
    event PolicyExpired(uint256 indexed id);
    event DepegHandled(
        uint256 indexed epoch,
        uint256 priceE18,
        uint256 originBlock,
        bytes32 originTxHash,
        uint256 paidCount,
        uint256 openRemaining,
        uint256 handledAt
    );
    event Recovered(
        uint256 indexed epoch, uint256 priceE18, uint256 originBlock, bytes32 originTxHash, uint256 handledAt
    );

    /// @param premiumBps_ flat premium per term, e.g. 200 = 2% of coverage
    /// @param term_ policy duration in seconds
    /// @param warmup_ delay before coverage starts, in seconds (anti front-running; 0 for demos)
    constructor(
        IPayable callbackProxy_,
        address sentinel_,
        IERC20Minimal asset_,
        uint256 premiumBps_,
        uint256 term_,
        uint256 warmup_
    ) payable AbstractCallback(callbackProxy_, sentinel_) {
        if (premiumBps_ == 0 || premiumBps_ >= BPS || term_ == 0) revert InvalidConfig();
        asset = asset_;
        premiumBps = premiumBps_;
        term = term_;
        warmup = warmup_;
    }

    // ---------------------------------------------------------------- views

    function totalAssets() public view returns (uint256) {
        return asset.balanceOf(address(this));
    }

    function freeAssets() public view returns (uint256) {
        uint256 assets = totalAssets();
        return assets > lockedCoverage ? assets - lockedCoverage : 0;
    }

    function depegActive() public view returns (bool) {
        return lastDepegEpoch > recoveredEpoch;
    }

    function quotePremium(uint256 coverage) public view returns (uint256) {
        return coverage * premiumBps / BPS;
    }

    function openPolicyIds() external view returns (uint256[] memory) {
        return _openIds;
    }

    /// @notice Most recent depeg epoch that occurred while the policy was active, or 0.
    function eligibleEpoch(uint256 id) public view returns (uint256) {
        Policy storage p = policies[id];
        if (p.holder == address(0) || p.settled) return 0;
        for (uint256 e = lastDepegEpoch; e != 0; e--) {
            uint64 t = depegTime[e];
            if (t < p.start) break;
            if (t < p.expiry) return e;
        }
        return 0;
    }

    // ---------------------------------------------------------- underwriters

    function deposit(uint256 assets) external returns (uint256 shares) {
        if (assets == 0) revert ZeroAmount();
        uint256 supply = totalShares;
        uint256 poolAssets = totalAssets();
        shares = supply == 0 || poolAssets == 0 ? assets : assets * supply / poolAssets;
        if (shares == 0) revert ZeroShares();

        totalShares = supply + shares;
        sharesOf[msg.sender] += shares;
        _pull(msg.sender, assets);
        emit Deposited(msg.sender, assets, shares);
    }

    /// @notice Withdraw is limited to capital not backing active coverage.
    function withdraw(uint256 shares) external returns (uint256 assets) {
        uint256 bal = sharesOf[msg.sender];
        if (shares == 0) revert ZeroAmount();
        if (bal < shares) revert InsufficientShares(bal, shares);

        assets = shares * totalAssets() / totalShares;
        uint256 free = freeAssets();
        if (assets > free) revert InsufficientFreeAssets(assets, free);

        sharesOf[msg.sender] = bal - shares;
        totalShares -= shares;
        _push(msg.sender, assets);
        emit Withdrawn(msg.sender, assets, shares);
    }

    // ---------------------------------------------------------------- buyers

    function buyPolicy(uint256 coverage) external returns (uint256 id) {
        if (coverage == 0) revert ZeroAmount();
        if (depegActive()) revert DepegActive();

        uint256 premium = quotePremium(coverage);
        uint256 capacity = freeAssets() + premium;
        if (coverage > capacity) revert InsufficientCapacity(coverage, capacity);

        id = nextPolicyId++;
        uint64 start = uint64(block.timestamp + warmup);
        uint64 expiry = uint64(start + term);
        policies[id] = Policy({holder: msg.sender, start: start, expiry: expiry, settled: false, coverage: coverage});
        _openIds.push(id);
        _openIndexPlusOne[id] = _openIds.length;
        lockedCoverage += coverage;

        _pull(msg.sender, premium);
        emit PolicyBought(id, msg.sender, coverage, premium, start, expiry);
    }

    /// @notice Pays a policy that was active during a confirmed depeg. Permissionless:
    ///         funds always go to the policy holder.
    function claim(uint256 id) external {
        uint256 e = eligibleEpoch(id);
        if (e == 0) revert NotEligible(id);
        _payout(id, e);
    }

    /// @notice Settles up to `maxCount` open policies: pays eligible ones, releases expired ones.
    function processQueue(uint256 maxCount) external returns (uint256 paid) {
        paid = _processQueue(maxCount);
    }

    // ------------------------------------------------------------- callbacks

    function onDepeg(address sentinel_, uint256 epoch_, uint256 priceE18_, uint256 originBlock_, uint256 originTxHash_)
        external
        onlyServiceProvider
        onlyCallbackSender(sentinel_)
    {
        if (epoch_ <= lastDepegEpoch) return;
        lastDepegEpoch = epoch_;
        depegTime[epoch_] = uint64(block.timestamp);

        uint256 paid = _processQueue(MAX_PUSH_PAYOUTS);
        emit DepegHandled(
            epoch_, priceE18_, originBlock_, bytes32(originTxHash_), paid, _openIds.length, block.timestamp
        );
    }

    function onRecover(
        address sentinel_,
        uint256 epoch_,
        uint256 priceE18_,
        uint256 originBlock_,
        uint256 originTxHash_
    ) external onlyServiceProvider onlyCallbackSender(sentinel_) {
        if (epoch_ <= recoveredEpoch) return;
        recoveredEpoch = epoch_;
        emit Recovered(epoch_, priceE18_, originBlock_, bytes32(originTxHash_), block.timestamp);
    }

    /// @notice Settles outstanding callback debt from this contract's native balance.
    function coverDebt() external {
        _coverDebt();
    }

    // -------------------------------------------------------------- internal

    /// @dev Iterates backwards so swap-and-pop never skips an unvisited id.
    function _processQueue(uint256 maxCount) internal returns (uint256 paid) {
        uint256 i = _openIds.length;
        uint256 visited;
        while (i != 0 && visited < maxCount) {
            i--;
            visited++;
            uint256 id = _openIds[i];
            uint256 e = eligibleEpoch(id);
            if (e != 0) {
                _payout(id, e);
                paid++;
            } else if (policies[id].expiry <= block.timestamp) {
                policies[id].settled = true;
                lockedCoverage -= policies[id].coverage;
                _removeOpen(id);
                emit PolicyExpired(id);
            }
        }
    }

    function _payout(uint256 id, uint256 epoch_) internal {
        Policy storage p = policies[id];
        p.settled = true;
        uint256 amount = p.coverage;
        lockedCoverage -= amount;
        _removeOpen(id);
        _push(p.holder, amount);
        emit PaidOut(id, p.holder, amount, epoch_);
    }

    function _removeOpen(uint256 id) internal {
        uint256 idx = _openIndexPlusOne[id];
        if (idx == 0) return;
        uint256 lastId = _openIds[_openIds.length - 1];
        _openIds[idx - 1] = lastId;
        _openIndexPlusOne[lastId] = idx;
        _openIds.pop();
        delete _openIndexPlusOne[id];
    }

    function _pull(address from, uint256 amount) internal {
        if (!asset.transferFrom(from, address(this), amount)) revert TokenTransferFailed();
    }

    function _push(address to, uint256 amount) internal {
        if (!asset.transfer(to, amount)) revert TokenTransferFailed();
    }
}
