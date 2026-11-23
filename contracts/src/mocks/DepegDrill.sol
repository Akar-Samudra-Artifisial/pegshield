// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IERC20Minimal} from "../interfaces/IERC20Minimal.sol";

interface IMintable {
    function mint(address to, uint256 amount) external;
}

interface IDrillPair {
    function swap(address tokenIn, uint256 amountIn, uint256 minOut, address to) external returns (uint256);
}

/// @title DepegDrill
/// @notice Testnet-only helper: one transaction mints mock stable and dumps it into the
///         pool `dumps` times, producing `dumps` consecutive `Sync` logs. Lets anyone run a
///         depeg drill from the dashboard without holding tokens.
contract DepegDrill {
    error InvalidDrill(uint256 amountPerDump, uint256 dumps);

    uint256 public constant MAX_DUMPS = 5;
    uint256 public constant MAX_PER_DUMP = 20_000e18;

    IDrillPair public immutable pair;
    address public immutable stable;

    event Drilled(address indexed caller, uint256 amountPerDump, uint256 dumps);

    constructor(IDrillPair pair_, address stable_) {
        pair = pair_;
        stable = stable_;
        IERC20Minimal(stable_).approve(address(pair_), type(uint256).max);
    }

    /// @notice Sells `amountPerDump` mock stable into the pool `dumps` times; proceeds go to the caller.
    function drill(uint256 amountPerDump, uint256 dumps) external {
        if (amountPerDump == 0 || amountPerDump > MAX_PER_DUMP || dumps == 0 || dumps > MAX_DUMPS) {
            revert InvalidDrill(amountPerDump, dumps);
        }
        IMintable(stable).mint(address(this), amountPerDump * dumps);
        for (uint256 i; i < dumps; ++i) {
            pair.swap(stable, amountPerDump, 0, msg.sender);
        }
        emit Drilled(msg.sender, amountPerDump, dumps);
    }
}
