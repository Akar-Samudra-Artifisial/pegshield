// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test, Vm} from "forge-std/Test.sol";
import {IReactive} from "@reactive/src/interfaces/IReactive.sol";
import {ISystemContract} from "@reactive/src/interfaces/ISystemContract.sol";

/// @dev Stand-in for the Reactive system contract: records subscriptions and callback requests.
contract MockSystem {
    event Subscribed(uint256 chainId, address target, uint256 topic0);
    event CallbackRequested(uint256 chainId, address recipient, uint64 gasLimit, bytes payload);

    function subscribe(uint256 chainId_, address contract_, uint256 topic0_, uint256, uint256, uint256) external {
        emit Subscribed(chainId_, contract_, topic0_);
    }

    function requestCallbackV_1_0(ISystemContract.CallbackConfiguration_V_1_0 memory c) external {
        emit CallbackRequested(c.chainId, c.recipient, c.gasLimit, c.payload);
    }

    function debt(address) external pure returns (uint256) {
        return 0;
    }

    receive() external payable {}
}

struct Callback {
    uint256 chainId;
    address recipient;
    uint64 gasLimit;
    bytes payload;
}

/// @dev Helpers to drive a reactive contract locally: build LogRecords from recorded EVM
///      logs and deliver callback payloads the way the callback proxy does.
abstract contract ReactiveHarness is Test {
    address internal constant SYSTEM = 0x8888888888888888888888888888888888888888;
    bytes32 internal constant CALLBACK_REQUESTED = keccak256("CallbackRequested(uint256,address,uint64,bytes)");

    function _installSystem() internal {
        vm.etch(SYSTEM, address(new MockSystem()).code);
    }

    function _toRecord(Vm.Log memory l, uint256 chainId, uint256 blockNumber, uint256 txHash)
        internal
        pure
        returns (IReactive.LogRecord memory r)
    {
        r.chainId = chainId;
        r.contractAddress = l.emitter;
        r.opCode = l.topics.length;
        if (l.topics.length > 0) r.topic0 = uint256(l.topics[0]);
        if (l.topics.length > 1) r.topic1 = uint256(l.topics[1]);
        if (l.topics.length > 2) r.topic2 = uint256(l.topics[2]);
        if (l.topics.length > 3) r.topic3 = uint256(l.topics[3]);
        r.data = l.data;
        r.blockNumber = blockNumber;
        r.txHash = txHash;
    }

    function _callbacks(Vm.Log[] memory logs) internal pure returns (Callback[] memory out) {
        uint256 n;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] == CALLBACK_REQUESTED) n++;
        }
        out = new Callback[](n);
        uint256 j;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] != CALLBACK_REQUESTED) continue;
            (uint256 c, address r, uint64 g, bytes memory p) =
                abi.decode(logs[i].data, (uint256, address, uint64, bytes));
            out[j++] = Callback(c, r, g, p);
        }
    }

    /// @dev The network overwrites the first argument (an address placeholder) with the
    ///      reactive contract's address before delivering through the callback proxy.
    function _deliver(Callback memory cb, address reactive, address proxy) internal returns (bool ok) {
        bytes memory p = cb.payload;
        assembly {
            mstore(add(p, 36), reactive)
        }
        vm.prank(proxy);
        (ok,) = cb.recipient.call{gas: cb.gasLimit}(p);
    }
}
