// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {IPayable} from "@reactive/src/interfaces/IPayable.sol";
import {AbstractCallback} from "@reactive/src/base/AbstractCallback.sol";
import {AbstractPayer} from "@reactive/src/base/AbstractPayer.sol";
import {PolicyVault} from "../src/PolicyVault.sol";
import {MockToken} from "../src/mocks/MockToken.sol";
import {IERC20Minimal} from "../src/interfaces/IERC20Minimal.sol";

contract PolicyVaultTest is Test {
    address constant PROXY = address(0x9999);
    address constant SENTINEL = address(0x5E);
    address constant UW = address(0x1001);
    address constant ALICE = address(0x2001);
    address constant BOB = address(0x2002);

    MockToken usd;
    PolicyVault v;

    function setUp() public {
        usd = new MockToken("Mock USD", "mUSD");
        // 2% premium, 7-day term, no warmup
        v = new PolicyVault(IPayable(payable(PROXY)), SENTINEL, IERC20Minimal(address(usd)), 200, 7 days, 0);
        _fund(UW, 100_000e18);
        _fund(ALICE, 10_000e18);
        _fund(BOB, 10_000e18);
        vm.prank(UW);
        v.deposit(100_000e18);
    }

    function _fund(address who, uint256 amt) internal {
        usd.mint(who, amt);
        vm.prank(who);
        usd.approve(address(v), type(uint256).max);
    }

    function _buy(address who, uint256 coverage) internal returns (uint256 id) {
        vm.prank(who);
        id = v.buyPolicy(coverage);
    }

    function _depeg(uint256 epoch) internal {
        vm.prank(PROXY);
        v.onDepeg(SENTINEL, epoch, 0.94e18, 123, 0xabc);
    }

    function _recover(uint256 epoch) internal {
        vm.prank(PROXY);
        v.onRecover(SENTINEL, epoch, 0.995e18, 130, 0xdef);
    }

    function test_buy_locksCoverage_andCollectsPremium() public {
        uint256 id = _buy(ALICE, 5_000e18);
        assertEq(id, 1);
        assertEq(v.lockedCoverage(), 5_000e18);
        assertEq(usd.balanceOf(ALICE), 10_000e18 - 100e18);
        assertEq(v.totalAssets(), 100_100e18);
        assertEq(v.openPolicyIds().length, 1);
    }

    function test_buy_rejectsOverCapacity() public {
        vm.expectRevert(abi.encodeWithSelector(PolicyVault.InsufficientCapacity.selector, 200_000e18, 104_000e18));
        _buy(ALICE, 200_000e18);
    }

    function test_depeg_paysActivePolicies_inCallback() public {
        _buy(ALICE, 5_000e18);
        _buy(BOB, 3_000e18);
        uint256 aliceBefore = usd.balanceOf(ALICE);

        _depeg(1);

        assertEq(usd.balanceOf(ALICE), aliceBefore + 5_000e18);
        assertEq(v.lockedCoverage(), 0);
        assertEq(v.openPolicyIds().length, 0);
        assertTrue(v.depegActive());
        (,,, bool settled,) = v.policies(1);
        assertTrue(settled);
    }

    function test_salesPaused_untilRecover() public {
        _depeg(1);
        vm.expectRevert(PolicyVault.DepegActive.selector);
        _buy(ALICE, 1_000e18);
        _recover(1);
        assertFalse(v.depegActive());
        _buy(ALICE, 1_000e18);
    }

    function test_callbacks_idempotent_andOrderTolerant() public {
        _buy(ALICE, 5_000e18);
        _recover(1); // arrives before onDepeg
        _depeg(1);
        assertFalse(v.depegActive());
        uint256 bal = usd.balanceOf(ALICE);
        _depeg(1); // duplicate is ignored
        assertEq(usd.balanceOf(ALICE), bal);
        assertEq(v.lastDepegEpoch(), 1);
    }

    function test_expiredPolicy_notPaid_andReleased() public {
        _buy(ALICE, 5_000e18);
        vm.warp(block.timestamp + 8 days);
        _depeg(1);
        (,,, bool settled,) = v.policies(1);
        assertTrue(settled);
        assertEq(usd.balanceOf(ALICE), 10_000e18 - 100e18);
        assertEq(v.lockedCoverage(), 0);
    }

    function test_pushLimit_restClaimable() public {
        uint256 n = v.MAX_PUSH_PAYOUTS() + 3;
        for (uint256 i; i < n; i++) {
            _buy(ALICE, 100e18);
        }
        _depeg(1);
        assertEq(v.openPolicyIds().length, 3);

        // Remains claimable even after expiry: coverage was active at depeg time.
        vm.warp(block.timestamp + 30 days);
        uint256 first = v.openPolicyIds()[0];
        assertEq(v.eligibleEpoch(first), 1);
        vm.prank(BOB); // permissionless, pays the holder
        v.claim(first);
        assertEq(v.processQueue(10), 2);
        assertEq(v.lockedCoverage(), 0);
        assertEq(usd.balanceOf(ALICE), 10_000e18 - n * 2e18 + n * 100e18);
    }

    function test_claim_rejectsIneligible() public {
        uint256 id = _buy(ALICE, 100e18);
        vm.expectRevert(abi.encodeWithSelector(PolicyVault.NotEligible.selector, id));
        v.claim(id);
    }

    function test_warmup_excludesFreshPolicies() public {
        PolicyVault w =
            new PolicyVault(IPayable(payable(PROXY)), SENTINEL, IERC20Minimal(address(usd)), 200, 7 days, 1 hours);
        usd.mint(UW, 10_020e18); // capital + premium
        vm.startPrank(UW);
        usd.approve(address(w), type(uint256).max);
        w.deposit(10_000e18);
        uint256 id = w.buyPolicy(1_000e18);
        vm.stopPrank();

        vm.prank(PROXY);
        w.onDepeg(SENTINEL, 1, 0.9e18, 1, 1);
        assertEq(w.eligibleEpoch(id), 0);
        assertEq(w.lockedCoverage(), 1_000e18);
    }

    function test_withdraw_limitedToFreeAssets() public {
        _buy(ALICE, 50_000e18);
        uint256 shares = v.sharesOf(UW);
        vm.prank(UW);
        vm.expectRevert(abi.encodeWithSelector(PolicyVault.InsufficientFreeAssets.selector, 101_000e18, 51_000e18));
        v.withdraw(shares);

        vm.prank(UW);
        uint256 out = v.withdraw(shares / 2);
        assertEq(out, 50_500e18); // half of pool incl. premium income
    }

    function test_underwriterAbsorbsLoss() public {
        _buy(ALICE, 10_000e18);
        _depeg(1);
        uint256 shares = v.sharesOf(UW);
        vm.prank(UW);
        uint256 out = v.withdraw(shares);
        assertEq(out, 100_000e18 + 200e18 - 10_000e18);
    }

    function test_callbacks_requireProxyAndSentinel() public {
        vm.expectRevert(abi.encodeWithSelector(AbstractPayer.NotAuthorized.selector, address(this), PROXY));
        v.onDepeg(SENTINEL, 1, 0, 0, 0);

        vm.prank(PROXY);
        vm.expectRevert(
            abi.encodeWithSelector(AbstractCallback.CallbackNotAuthorized.selector, address(0xBAD), SENTINEL)
        );
        v.onDepeg(address(0xBAD), 1, 0, 0, 0);
    }
}
