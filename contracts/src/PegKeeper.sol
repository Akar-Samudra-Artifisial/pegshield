// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IPayable} from "@reactive/src/interfaces/IPayable.sol";
import {AbstractCallback} from "@reactive/src/base/AbstractCallback.sol";
import {IERC20Minimal} from "./interfaces/IERC20Minimal.sol";

interface IKeeperPair {
    function token0() external view returns (IERC20Minimal);
    function token1() external view returns (IERC20Minimal);
    function getReserves() external view returns (uint112, uint112, uint32);
    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) external pure returns (uint256);
    function swap(address tokenIn, uint256 amountIn, uint256 minOut, address to) external returns (uint256);
}

/// @title PegKeeper
/// @notice Treasury on the pool's chain that buys the depegged stable back toward parity
///         when DepegSentinel asks it to. Each round spends at most `maxPerRound` of the
///         quote asset, sized from live reserves (not from the callback payload).
contract PegKeeper is AbstractCallback {
    enum SkipReason {
        DUPLICATE,
        ALREADY_PEGGED,
        NO_FUNDS
    }

    error NotOwner();
    error TokenTransferFailed();

    IKeeperPair public immutable pair;
    IERC20Minimal public immutable stable;
    IERC20Minimal public immutable quote;
    bool public immutable stableIsToken0;
    uint256 public immutable maxPerRound;
    address public immutable owner;

    mapping(uint256 => uint256) public lastRound;

    event Defended(
        uint256 indexed epoch,
        uint256 indexed round,
        uint256 quoteIn,
        uint256 stableOut,
        uint256 priceBeforeE18,
        uint256 priceAfterE18,
        uint256 originBlock,
        bytes32 originTxHash,
        uint256 handledAt
    );
    event DefenseSkipped(uint256 indexed epoch, uint256 indexed round, SkipReason reason, uint256 priceE18);

    constructor(
        IPayable callbackProxy_,
        address sentinel_,
        IKeeperPair pair_,
        bool stableIsToken0_,
        uint256 maxPerRound_
    ) payable AbstractCallback(callbackProxy_, sentinel_) {
        pair = pair_;
        stableIsToken0 = stableIsToken0_;
        (stable, quote) = stableIsToken0_ ? (pair_.token0(), pair_.token1()) : (pair_.token1(), pair_.token0());
        maxPerRound = maxPerRound_;
        owner = msg.sender;
    }

    function defend(
        address sentinel_,
        uint256 epoch_,
        uint256 round_,
        uint256 reportedPriceE18_,
        uint256 originBlock_,
        uint256 originTxHash_
    ) external onlyServiceProvider onlyCallbackSender(sentinel_) {
        if (round_ <= lastRound[epoch_]) {
            emit DefenseSkipped(epoch_, round_, SkipReason.DUPLICATE, reportedPriceE18_);
            return;
        }
        lastRound[epoch_] = round_;
        _defend(epoch_, round_, originBlock_, originTxHash_);
    }

    /// @notice Current pool price of the stable in quote units, 1e18 = parity.
    function poolPriceE18() public view returns (uint256) {
        (uint256 rStable, uint256 rQuote) = _reserves();
        return rStable == 0 ? 0 : rQuote * 1e18 / rStable;
    }

    function _defend(uint256 epoch_, uint256 round_, uint256 originBlock_, uint256 originTxHash_) internal {
        (uint256 rStable, uint256 rQuote) = _reserves();
        uint256 priceBefore = poolPriceE18();
        if (rStable == 0 || priceBefore >= 1e18) {
            emit DefenseSkipped(epoch_, round_, SkipReason.ALREADY_PEGGED, priceBefore);
            return;
        }

        (uint256 amountIn, uint256 out) = _buyStable(rStable, rQuote);
        if (amountIn == 0) {
            emit DefenseSkipped(epoch_, round_, SkipReason.NO_FUNDS, priceBefore);
            return;
        }

        emit Defended(
            epoch_,
            round_,
            amountIn,
            out,
            priceBefore,
            poolPriceE18(),
            originBlock_,
            bytes32(originTxHash_),
            block.timestamp
        );
    }

    /// @dev Spends min(needed, maxPerRound, balance) of the quote asset; returns (0, 0) if broke.
    function _buyStable(uint256 rStable, uint256 rQuote) internal returns (uint256 amountIn, uint256 out) {
        amountIn = quoteNeeded(rStable, rQuote);
        if (amountIn > maxPerRound) amountIn = maxPerRound;
        uint256 balance = quote.balanceOf(address(this));
        if (amountIn > balance) amountIn = balance;
        if (amountIn == 0) return (0, 0);

        uint256 expectedOut = pair.getAmountOut(amountIn, rQuote, rStable);
        if (!quote.approve(address(pair), amountIn)) revert TokenTransferFailed();
        out = pair.swap(address(quote), amountIn, expectedOut, address(this));
    }

    /// @notice Quote amount (fee-inclusive) that moves the pool to parity:
    ///         at parity rQuote' = rStable' = sqrt(k), so the input is sqrt(k) - rQuote.
    function quoteNeeded(uint256 rStable, uint256 rQuote) public pure returns (uint256) {
        uint256 target = _sqrt(rStable * rQuote);
        if (target <= rQuote) return 0;
        return (target - rQuote) * 1000 / 997;
    }

    /// @notice Owner can recover bought stables or unused treasury.
    function sweep(IERC20Minimal token, address to, uint256 amount) external {
        if (msg.sender != owner) revert NotOwner();
        if (!token.transfer(to, amount)) revert TokenTransferFailed();
    }

    /// @notice Settles outstanding callback debt from this contract's native balance.
    function coverDebt() external {
        _coverDebt();
    }

    function _reserves() internal view returns (uint256 rStable, uint256 rQuote) {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        (rStable, rQuote) = stableIsToken0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }

    function _sqrt(uint256 x) internal pure returns (uint256 z) {
        if (x == 0) return 0;
        z = x;
        uint256 y = x / 2 + 1;
        while (y < z) {
            z = y;
            y = (x / y + y) / 2;
        }
    }
}
