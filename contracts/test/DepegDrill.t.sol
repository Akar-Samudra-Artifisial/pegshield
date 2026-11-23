// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test, Vm} from "forge-std/Test.sol";
import {MockToken} from "../src/mocks/MockToken.sol";
import {MockPair} from "../src/mocks/MockPair.sol";
import {DepegDrill, IDrillPair} from "../src/mocks/DepegDrill.sol";
import {IERC20Minimal} from "../src/interfaces/IERC20Minimal.sol";

contract DepegDrillTest is Test {
    MockToken stable;
    MockToken usd;
    MockPair pair;
    DepegDrill drill;
    address constant CALLER = address(0xCA11);

    function setUp() public {
        stable = new MockToken("Mock Stable", "mSTB");
        usd = new MockToken("Mock USD", "mUSD");
        pair = new MockPair(IERC20Minimal(address(stable)), IERC20Minimal(address(usd)));
        stable.mint(address(this), 100_000e18);
        usd.mint(address(this), 100_000e18);
        stable.approve(address(pair), type(uint256).max);
        usd.approve(address(pair), type(uint256).max);
        pair.addLiquidity(100_000e18, 100_000e18);
        drill = new DepegDrill(IDrillPair(address(pair)), address(stable));
    }

    function test_drill_emitsOneSyncPerDump_andDropsPrice() public {
        vm.recordLogs();
        vm.prank(CALLER);
        drill.drill(2_000e18, 3);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 syncTopic = keccak256("Sync(uint112,uint112)");
        uint256 syncs;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(pair) && logs[i].topics[0] == syncTopic) ++syncs;
        }
        assertEq(syncs, 3);
        assertLt(pair.priceE18(), 0.97e18);
        assertGt(usd.balanceOf(CALLER), 0);
        assertEq(stable.balanceOf(address(drill)), 0);
    }

    function test_drill_rejectsOutOfRange() public {
        vm.expectRevert(abi.encodeWithSelector(DepegDrill.InvalidDrill.selector, 0, 3));
        drill.drill(0, 3);
        vm.expectRevert(abi.encodeWithSelector(DepegDrill.InvalidDrill.selector, 1e18, 6));
        drill.drill(1e18, 6);
        vm.expectRevert(abi.encodeWithSelector(DepegDrill.InvalidDrill.selector, 20_001e18, 1));
        drill.drill(20_001e18, 1);
    }
}
