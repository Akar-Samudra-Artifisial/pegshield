// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IReactive} from "@reactive/src/interfaces/IReactive.sol";
import {AbstractPayer} from "@reactive/src/base/AbstractPayer.sol";
import {DepegSentinel} from "../src/DepegSentinel.sol";
import {ReactiveHarness, Callback} from "./utils/ReactiveHarness.sol";

contract DepegSentinelTest is ReactiveHarness {
    uint256 constant BASE = 84532;
    uint256 constant UNI = 1301;
    address constant PAIR = address(0xA11);
    address constant VAULT = address(0xA22);
    address constant KEEPER = address(0xA33);

    DepegSentinel s;
    uint256 syncTopic;
    uint256 blockNo = 100;

    function setUp() public {
        _installSystem();
        // stable = token0; watch 0.97, recover 0.99, 3 confirmations, cooldown 2 blocks, 3 rounds
        s = new DepegSentinel(BASE, PAIR, true, 9700, 9900, 3, 2, 3);
        s.setDestinations(UNI, VAULT, BASE, KEEPER);
        syncTopic = s.SYNC_TOPIC_0();
    }

    function _sync(uint256 priceBps) internal returns (IReactive.LogRecord memory r) {
        r.chainId = BASE;
        r.contractAddress = PAIR;
        r.topic0 = syncTopic;
        r.opCode = 1;
        r.data = abi.encode(uint112(1_000_000e18), uint112(priceBps * 100e18));
        r.blockNumber = blockNo++;
        r.txHash = blockNo;
    }

    function _react(IReactive.LogRecord memory r) internal returns (Callback[] memory) {
        vm.recordLogs();
        vm.prank(SYSTEM);
        s.react(r);
        return _callbacks(vm.getRecordedLogs());
    }

    function _push(uint256 priceBps) internal returns (Callback[] memory) {
        return _react(_sync(priceBps));
    }

    function _selector(bytes memory payload) internal pure returns (bytes4 sel) {
        assembly {
            sel := mload(add(payload, 32))
        }
    }

    function test_constructor_rejectsBadConfig() public {
        vm.expectRevert(DepegSentinel.InvalidConfig.selector);
        new DepegSentinel(BASE, PAIR, true, 9900, 9700, 3, 2, 3);
        vm.expectRevert(DepegSentinel.InvalidConfig.selector);
        new DepegSentinel(BASE, PAIR, true, 9700, 9900, 0, 2, 3);
    }

    function test_normal_staysNormalAbovePeg() public {
        assertEq(_push(9990).length, 0);
        assertEq(uint8(s.status()), uint8(DepegSentinel.Status.NORMAL));
        assertEq(s.lastPriceE18(), 0.999e18);
    }

    function test_watch_thenBackToNormal() public {
        _push(9600);
        assertEq(uint8(s.status()), uint8(DepegSentinel.Status.WATCH));
        _push(9750);
        assertEq(uint8(s.status()), uint8(DepegSentinel.Status.NORMAL));
        assertEq(s.belowCount(), 0);
        assertEq(s.epoch(), 0);
    }

    function test_depeg_afterConfirmations_firesVaultAndKeeper() public {
        assertEq(_push(9600).length, 0);
        assertEq(_push(9500).length, 0);
        Callback[] memory cbs = _push(9400);

        assertEq(uint8(s.status()), uint8(DepegSentinel.Status.DEPEGGED));
        assertEq(s.epoch(), 1);
        assertEq(cbs.length, 2);

        assertEq(cbs[0].chainId, UNI);
        assertEq(cbs[0].recipient, VAULT);
        assertEq(cbs[0].gasLimit, s.VAULT_GAS_LIMIT());
        assertEq(_selector(cbs[0].payload), bytes4(keccak256("onDepeg(address,uint256,uint256,uint256,uint256)")));

        assertEq(cbs[1].chainId, BASE);
        assertEq(cbs[1].recipient, KEEPER);
        assertEq(
            _selector(cbs[1].payload), bytes4(keccak256("defend(address,uint256,uint256,uint256,uint256,uint256)"))
        );
        assertEq(s.keeperRounds(), 1);
    }

    function test_keeper_respectsCooldownAndMaxRounds() public {
        _push(9600);
        _push(9500);
        _push(9400); // round 1 at block 102
        assertEq(_push(9400).length, 0, "cooldown: block 103 < 102 + 2");
        assertEq(_push(9400).length, 1, "round 2 at block 104");
        _push(9400); // 105: cooldown
        assertEq(_push(9400).length, 1, "round 3 at block 106");
        blockNo += 10;
        assertEq(_push(9400).length, 0, "max rounds reached");
        assertEq(s.keeperRounds(), 3);
    }

    function test_recover_requiresHysteresis_andNotifiesVault() public {
        _push(9600);
        _push(9500);
        _push(9400);
        blockNo += 10;
        _push(9850); // above watch, below recover: still depegged, keeper round 2
        assertEq(uint8(s.status()), uint8(DepegSentinel.Status.DEPEGGED));

        Callback[] memory cbs = _push(9950);
        assertEq(uint8(s.status()), uint8(DepegSentinel.Status.NORMAL));
        assertEq(cbs.length, 1);
        assertEq(cbs[0].recipient, VAULT);
        assertEq(_selector(cbs[0].payload), bytes4(keccak256("onRecover(address,uint256,uint256,uint256,uint256)")));
    }

    function test_secondDepeg_incrementsEpoch_resetsRounds() public {
        _push(9600);
        _push(9500);
        _push(9400);
        _push(9950);
        _push(9600);
        _push(9500);
        _push(9400);
        assertEq(s.epoch(), 2);
        assertEq(s.keeperRounds(), 1);
    }

    function test_react_ignoresForeignLogs_withoutReverting() public {
        IReactive.LogRecord memory r = _sync(9000);
        r.contractAddress = address(0xBAD);
        assertEq(_react(r).length, 0);

        r = _sync(9000);
        r.topic0 = 1;
        _react(r);

        r = _sync(9000);
        r.chainId = UNI;
        _react(r);

        r = _sync(9000);
        r.data = hex"01";
        _react(r);

        r = _sync(9000);
        r.data = abi.encode(uint256(0), uint256(1));
        _react(r);

        assertEq(uint8(s.status()), uint8(DepegSentinel.Status.NORMAL));
    }

    function test_react_onlySystem() public {
        IReactive.LogRecord memory r = _sync(9000);
        vm.expectRevert(abi.encodeWithSelector(AbstractPayer.NotAuthorized.selector, address(this), SYSTEM));
        s.react(r);
    }

    function test_setDestinations_onlyOwner() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(DepegSentinel.NotOwner.selector);
        s.setDestinations(0, address(0), 0, address(0));
    }

    function test_disabledLegs_requestNothing() public {
        s.setDestinations(0, address(0), 0, address(0));
        _push(9600);
        _push(9500);
        assertEq(_push(9400).length, 0);
        assertEq(s.epoch(), 1);
    }

    function test_stableAsToken1_invertsPrice() public {
        DepegSentinel inv = new DepegSentinel(BASE, PAIR, false, 9700, 9900, 1, 0, 1);
        IReactive.LogRecord memory r = _sync(9000);
        // reserves (r0 = 1.0M quote, r1 = 0.9M) => stable(token1) price = 1/0.9 > 1
        vm.prank(SYSTEM);
        inv.react(r);
        assertEq(uint8(inv.status()), uint8(DepegSentinel.Status.NORMAL));
        assertGt(inv.lastPriceE18(), 1e18);
    }
}
