// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test, Vm} from "forge-std/Test.sol";
import {IPayable} from "@reactive/src/interfaces/IPayable.sol";
import {AbstractCallback} from "@reactive/src/base/AbstractCallback.sol";
import {PegKeeper, IKeeperPair} from "../src/PegKeeper.sol";
import {MockToken} from "../src/mocks/MockToken.sol";
import {MockPair} from "../src/mocks/MockPair.sol";
import {IERC20Minimal} from "../src/interfaces/IERC20Minimal.sol";

contract PegKeeperTest is Test {
    address constant PROXY = address(0x9999);
    address constant SENTINEL = address(0x5E);

    MockToken stable;
    MockToken usd;
    MockPair pair;
    PegKeeper k;

    function setUp() public {
        stable = new MockToken("Mock Stable", "mSTB");
        usd = new MockToken("Mock USD", "mUSD");
        pair = new MockPair(IERC20Minimal(address(stable)), IERC20Minimal(address(usd)));

        stable.mint(address(this), 1_000_000e18);
        usd.mint(address(this), 1_000_000e18);
        stable.approve(address(pair), type(uint256).max);
        usd.approve(address(pair), type(uint256).max);
        pair.addLiquidity(100_000e18, 100_000e18);

        k = new PegKeeper(IPayable(payable(PROXY)), SENTINEL, IKeeperPair(address(pair)), true, 50_000e18);
        usd.mint(address(k), 200_000e18);
    }

    function _dump(uint256 amount) internal {
        pair.swap(address(stable), amount, 0, address(this));
    }

    function _defend(uint256 epoch, uint256 round) internal {
        vm.prank(PROXY);
        k.defend(SENTINEL, epoch, round, 0.9e18, 1, 1);
    }

    function test_mockPair_swapEmitsSync_andMovesPrice() public {
        vm.recordLogs();
        _dump(10_000e18);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs[logs.length - 1].topics[0], keccak256("Sync(uint112,uint112)"));
        assertLt(pair.priceE18(), 0.83e18);
        assertGt(pair.priceE18(), 0.82e18);
    }

    function test_defend_restoresParity() public {
        _dump(10_000e18);
        _defend(1, 1);
        uint256 p = pair.priceE18();
        assertGe(p, 0.999e18);
        assertLe(p, 1.001e18);
        assertGt(stable.balanceOf(address(k)), 0);
    }

    function test_defend_cappedPerRound() public {
        _dump(150_000e18); // needs ~60k to restore, cap is 50k
        uint256 before = usd.balanceOf(address(k));
        _defend(1, 1);
        assertEq(before - usd.balanceOf(address(k)), 50_000e18);
        assertLt(pair.priceE18(), 0.97e18);
        _defend(1, 2);
        assertGe(pair.priceE18(), 0.999e18);
    }

    function test_defend_skipsDuplicateRound() public {
        _dump(10_000e18);
        _defend(1, 1);
        _dump(10_000e18);
        uint256 bal = usd.balanceOf(address(k));
        _defend(1, 1);
        assertEq(usd.balanceOf(address(k)), bal);
    }

    function test_defend_skipsWhenPegged() public {
        uint256 bal = usd.balanceOf(address(k));
        _defend(1, 1);
        assertEq(usd.balanceOf(address(k)), bal);
    }

    function test_defend_noFunds() public {
        PegKeeper broke = new PegKeeper(IPayable(payable(PROXY)), SENTINEL, IKeeperPair(address(pair)), true, 1e18);
        _dump(10_000e18);
        vm.prank(PROXY);
        broke.defend(SENTINEL, 1, 1, 0, 0, 0);
        assertLt(pair.priceE18(), 0.9e18);
    }

    function test_defend_requiresSentinel() public {
        vm.prank(PROXY);
        vm.expectRevert(
            abi.encodeWithSelector(AbstractCallback.CallbackNotAuthorized.selector, address(0xBAD), SENTINEL)
        );
        k.defend(address(0xBAD), 1, 1, 0, 0, 0);
    }

    function test_sweep_onlyOwner() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(PegKeeper.NotOwner.selector);
        k.sweep(IERC20Minimal(address(usd)), address(0xBAD), 1);
        k.sweep(IERC20Minimal(address(usd)), address(this), 1);
    }
}
