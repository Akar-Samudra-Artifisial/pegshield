// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IERC20Minimal} from "../interfaces/IERC20Minimal.sol";

/// @title MockPair
/// @notice Constant-product pool (0.3% fee) that emits Uniswap V2-compatible `Sync`
///         and `Swap` events, so the sentinel would work unchanged against a real V2 pair.
///         Simplified for demos: no LP shares, `addLiquidity` is a donation.
///         Price convention: token1 per token0, scaled by 1e18.
contract MockPair {
    error InvalidToken(address token);
    error ZeroAmount();
    error InsufficientLiquidity();
    error InsufficientOutput(uint256 amountOut, uint256 minOut);
    error ReserveOverflow();
    error TransferFailed();

    IERC20Minimal public immutable token0;
    IERC20Minimal public immutable token1;

    uint112 private _reserve0;
    uint112 private _reserve1;
    uint32 private _blockTimestampLast;

    event Sync(uint112 reserve0, uint112 reserve1);
    event Swap(
        address indexed sender,
        uint256 amount0In,
        uint256 amount1In,
        uint256 amount0Out,
        uint256 amount1Out,
        address indexed to
    );
    event LiquidityAdded(address indexed provider, uint256 amount0, uint256 amount1);

    constructor(IERC20Minimal token0_, IERC20Minimal token1_) {
        token0 = token0_;
        token1 = token1_;
    }

    function getReserves() public view returns (uint112, uint112, uint32) {
        return (_reserve0, _reserve1, _blockTimestampLast);
    }

    /// @notice Spot price of token0 denominated in token1, 1e18 = parity.
    function priceE18() external view returns (uint256) {
        if (_reserve0 == 0) return 0;
        return uint256(_reserve1) * 1e18 / _reserve0;
    }

    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) public pure returns (uint256) {
        if (amountIn == 0) revert ZeroAmount();
        if (reserveIn == 0 || reserveOut == 0) revert InsufficientLiquidity();
        uint256 inWithFee = amountIn * 997;
        return inWithFee * reserveOut / (reserveIn * 1000 + inWithFee);
    }

    function addLiquidity(uint256 amount0, uint256 amount1) external {
        if (amount0 == 0 && amount1 == 0) revert ZeroAmount();
        if (amount0 != 0) _pull(token0, amount0);
        if (amount1 != 0) _pull(token1, amount1);
        emit LiquidityAdded(msg.sender, amount0, amount1);
        _update();
    }

    /// @notice Exact-input swap. Caller must approve `amountIn` of `tokenIn` first.
    function swap(address tokenIn, uint256 amountIn, uint256 minOut, address to) external returns (uint256 amountOut) {
        bool zeroForOne;
        if (tokenIn == address(token0)) zeroForOne = true;
        else if (tokenIn != address(token1)) revert InvalidToken(tokenIn);

        (uint256 rIn, uint256 rOut) = zeroForOne ? (_reserve0, _reserve1) : (_reserve1, _reserve0);
        amountOut = getAmountOut(amountIn, rIn, rOut);
        if (amountOut < minOut) revert InsufficientOutput(amountOut, minOut);

        IERC20Minimal tokenOut = zeroForOne ? token1 : token0;
        _pull(IERC20Minimal(tokenIn), amountIn);
        if (!tokenOut.transfer(to, amountOut)) revert TransferFailed();

        if (zeroForOne) emit Swap(msg.sender, amountIn, 0, 0, amountOut, to);
        else emit Swap(msg.sender, 0, amountIn, amountOut, 0, to);
        _update();
    }

    function _pull(IERC20Minimal token, uint256 amount) internal {
        if (!token.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
    }

    function _update() internal {
        uint256 b0 = token0.balanceOf(address(this));
        uint256 b1 = token1.balanceOf(address(this));
        if (b0 > type(uint112).max || b1 > type(uint112).max) revert ReserveOverflow();
        _reserve0 = uint112(b0);
        _reserve1 = uint112(b1);
        _blockTimestampLast = uint32(block.timestamp);
        emit Sync(uint112(b0), uint112(b1));
    }
}
