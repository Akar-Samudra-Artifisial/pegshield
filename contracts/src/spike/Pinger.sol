// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @title Pinger
/// @notice Origin-side contract for the latency spike. Each `ping()` emits an event
///         that the reactive contract on Lasna subscribes to.
contract Pinger {
    event Ping(uint256 indexed id, address indexed sender);

    uint256 public nextId;

    function ping() external returns (uint256 id) {
        id = ++nextId;
        emit Ping(id, msg.sender);
    }
}
