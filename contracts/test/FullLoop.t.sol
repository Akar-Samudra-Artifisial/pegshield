// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Vm} from "forge-std/Test.sol";
import {IPayable} from "@reactive/src/interfaces/IPayable.sol";
import {DepegSentinel} from "../src/DepegSentinel.sol";
import {PolicyVault} from "../src/PolicyVault.sol";
import {PegKeeper, IKeeperPair} from "../src/PegKeeper.sol";
import {MockToken} from "../src/mocks/MockToken.sol";
import {MockPair} from "../src/mocks/MockPair.sol";
import {IERC20Minimal} from "../src/interfaces/IERC20Minimal.sol";
import {ReactiveHarness, Callback} from "./utils/ReactiveHarness.sol";

/// @notice Local simulation of the whole loop: pool Sync -> sentinel.react -> callbacks to
///         vault and keeper -> keeper swap emits Sync -> sentinel sees recovery -> onRecover.
contract FullLoopTest is ReactiveHarness {
    uint256 constant BASE = 84532;
    uint256 constant UNI = 1301;
    address constant PROXY = address(0x9999);
    address constant ALICE = address(0xA11CE);
    address constant WHALE = address(0x3A1E);

    MockToken stable;
    MockToken usd;
    MockToken uniUsd;
    MockPair pair;
    DepegSentinel sentinel;
    PolicyVault vault;
    PegKeeper keeper;

    uint256 blk = 1000;
    uint256 callbacksDelivered;
    bytes32 syncTopic = keccak256("Sync(uint112,uint112)");

    function setUp() public {
        _installSystem();

        // Base: pool + keeper
        stable = new MockToken("Mock Stable", "mSTB");
        usd = new MockToken("Mock USD", "mUSD");
        pair = new MockPair(IERC20Minimal(address(stable)), IERC20Minimal(address(usd)));
        stable.mint(address(this), 100_000e18);
        usd.mint(address(this), 100_000e18);
        stable.approve(address(pair), type(uint256).max);
        usd.approve(address(pair), type(uint256).max);
        pair.addLiquidity(100_000e18, 100_000e18);

        // Lasna: sentinel (deployed first, callbacks need its address)
        sentinel = new DepegSentinel(BASE, address(pair), true, 9700, 9900, 3, 1, 3);

        keeper = new PegKeeper(IPayable(payable(PROXY)), address(sentinel), IKeeperPair(address(pair)), true, 50_000e18);
        usd.mint(address(keeper), 100_000e18);

        // Unichain: vault with its own settlement token
        uniUsd = new MockToken("Mock USD (Unichain)", "mUSD");
        vault = new PolicyVault(
            IPayable(payable(PROXY)), address(sentinel), IERC20Minimal(address(uniUsd)), 200, 7 days, 0
        );
        uniUsd.mint(address(this), 50_000e18);
        uniUsd.approve(address(vault), type(uint256).max);
        vault.deposit(50_000e18);

        sentinel.setDestinations(UNI, address(vault), BASE, address(keeper));

        uniUsd.mint(ALICE, 1_000e18);
        vm.startPrank(ALICE);
        uniUsd.approve(address(vault), type(uint256).max);
        vault.buyPolicy(10_000e18);
        vm.stopPrank();

        stable.mint(WHALE, 50_000e18);
        vm.prank(WHALE);
        stable.approve(address(pair), type(uint256).max);
    }

    function _dump(uint256 amount) internal {
        vm.recordLogs();
        vm.prank(WHALE);
        pair.swap(address(stable), amount, 0, WHALE);
        _relay(vm.getRecordedLogs());
    }

    /// @dev Feeds every pool Sync to the sentinel and delivers resulting callbacks,
    ///      recursively relaying logs the callbacks emit (the keeper's own swap).
    function _relay(Vm.Log[] memory logs) internal {
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != address(pair) || logs[i].topics[0] != syncTopic) continue;

            vm.recordLogs();
            vm.prank(SYSTEM);
            sentinel.react(_toRecord(logs[i], BASE, ++blk, uint256(keccak256(abi.encode(blk)))));
            Callback[] memory cbs = _callbacks(vm.getRecordedLogs());

            for (uint256 j; j < cbs.length; j++) {
                vm.recordLogs();
                assertTrue(_deliver(cbs[j], address(sentinel), PROXY), "callback reverted");
                callbacksDelivered++;
                _relay(vm.getRecordedLogs());
            }
        }
    }

    function test_fullLoop_depegPaysOut_keeperRestoresPeg_vaultReopens() public {
        uint256 aliceBefore = uniUsd.balanceOf(ALICE);

        _dump(2_000e18);
        assertEq(uint8(sentinel.status()), uint8(DepegSentinel.Status.WATCH));
        _dump(2_000e18);
        assertEq(uint8(sentinel.status()), uint8(DepegSentinel.Status.WATCH));
        _dump(2_000e18);

        // Confirmed depeg -> payout on Unichain + keeper swap on Base -> recovery
        assertEq(sentinel.epoch(), 1);
        assertEq(uniUsd.balanceOf(ALICE), aliceBefore + 10_000e18, "policy paid");
        assertGe(pair.priceE18(), 0.99e18, "peg restored");
        assertEq(uint8(sentinel.status()), uint8(DepegSentinel.Status.NORMAL));
        assertEq(vault.recoveredEpoch(), 1);
        assertFalse(vault.depegActive());
        assertEq(callbacksDelivered, 3, "onDepeg + defend + onRecover");
    }

    function test_fullLoop_smallDipDoesNotTrigger() public {
        _dump(2_000e18);
        usd.mint(address(this), 2_500e18);
        vm.recordLogs();
        pair.swap(address(usd), 2_500e18, 0, address(this));
        _relay(vm.getRecordedLogs());

        assertEq(uint8(sentinel.status()), uint8(DepegSentinel.Status.NORMAL));
        assertEq(sentinel.epoch(), 0);
        assertEq(callbacksDelivered, 0);
    }
}
