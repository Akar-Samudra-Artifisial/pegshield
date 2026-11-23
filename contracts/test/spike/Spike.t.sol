// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { Test, Vm } from "forge-std/Test.sol";
import { IReactive } from "@reactive/src/interfaces/IReactive.sol";
import { IPayable } from "@reactive/src/interfaces/IPayable.sol";
import { ISystemContract } from "@reactive/src/interfaces/ISystemContract.sol";
import { AbstractCallback } from "@reactive/src/base/AbstractCallback.sol";
import { AbstractPayer } from "@reactive/src/base/AbstractPayer.sol";
import { SpikeReactive } from "../../src/spike/SpikeReactive.sol";
import { SpikeCallback } from "../../src/spike/SpikeCallback.sol";

/// @dev Minimal stand-in for the system contract: records subscriptions and callback requests.
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

    receive() external payable { }
}

contract SpikeTest is Test {
    address constant SYSTEM = 0x8888888888888888888888888888888888888888;
    uint256 constant BASE = 84532;
    uint256 constant UNI = 1301;
    address pinger = address(0xBEEF);
    address proxy = address(0x9999);

    SpikeReactive reactive;
    SpikeCallback cbA;

    function setUp() public {
        vm.etch(SYSTEM, address(new MockSystem()).code);
        reactive = new SpikeReactive(BASE, pinger);
        cbA = new SpikeCallback(IPayable(payable(proxy)), address(reactive));
        reactive.setRecipients(BASE, address(cbA), UNI, address(0xCAFE));
    }

    function _log(uint256 topic0, uint256 opCode) internal view returns (IReactive.LogRecord memory l) {
        l = IReactive.LogRecord({
            chainId: BASE,
            contractAddress: pinger,
            topic0: topic0,
            topic1: 7,
            topic2: uint256(uint160(address(this))),
            topic3: 0,
            data: "",
            blockNumber: 123,
            opCode: opCode,
            blockHash: 0,
            txHash: 0xabc,
            logIndex: 0
        });
    }

    function test_react_requestsTwoCallbacks() public {
        IReactive.LogRecord memory l = _log(reactive.PING_TOPIC_0(), 3);
        vm.recordLogs();
        vm.prank(SYSTEM);
        reactive.react(l);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("CallbackRequested(uint256,address,uint64,bytes)");
        uint256 n;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics[0] == sig) n++;
        }
        assertEq(n, 2);
    }

    function test_react_ignoresOtherTopics() public {
        vm.recordLogs();
        vm.prank(SYSTEM);
        reactive.react(_log(1, 3));
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function test_react_onlySystem() public {
        IReactive.LogRecord memory l = _log(reactive.PING_TOPIC_0(), 3);
        vm.expectRevert(abi.encodeWithSelector(AbstractPayer.NotAuthorized.selector, address(this), SYSTEM));
        reactive.react(l);
    }

    function test_setRecipients_onlyOwner() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(SpikeReactive.NotOwner.selector);
        reactive.setRecipients(0, address(0), 0, address(0));
    }

    function test_callback_acceptsProxyAndSender() public {
        vm.prank(proxy);
        cbA.onPing(address(reactive), 7, BASE, 123, 0xabc);
        assertEq(cbA.lastId(), 7);
    }

    function test_callback_rejectsWrongSender() public {
        vm.prank(proxy);
        vm.expectRevert(
            abi.encodeWithSelector(AbstractCallback.CallbackNotAuthorized.selector, address(0xBAD), address(reactive))
        );
        cbA.onPing(address(0xBAD), 7, BASE, 123, 0xabc);
    }

    function test_callback_rejectsNonProxy() public {
        vm.expectRevert(abi.encodeWithSelector(AbstractPayer.NotAuthorized.selector, address(this), proxy));
        cbA.onPing(address(reactive), 7, BASE, 123, 0xabc);
    }
}
