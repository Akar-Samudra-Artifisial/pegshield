// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { ISystemContract } from "@reactive/src/interfaces/ISystemContract.sol";
import { IReactive } from "@reactive/src/interfaces/IReactive.sol";
import { AbstractReactive } from "@reactive/src/base/AbstractReactive.sol";

/// @title SpikeReactive
/// @notice Lasna-side contract for the latency spike. One origin event fans out into
///         callbacks on up to two destination chains, carrying origin metadata so the
///         full loop can be timed.
contract SpikeReactive is AbstractReactive {
    error NotOwner();

    /// keccak256("Ping(uint256,address)")
    uint256 public constant PING_TOPIC_0 = uint256(keccak256("Ping(uint256,address)"));
    uint64 public constant CALLBACK_GAS_LIMIT = 300_000;

    address public immutable owner;
    uint256 public immutable originChainId;
    address public immutable originContract;

    uint256 public destChainA;
    address public recipientA;
    uint256 public destChainB;
    address public recipientB;

    event RecipientsSet(uint256 chainA, address recipientA, uint256 chainB, address recipientB);
    event Relayed(uint256 indexed id, uint256 originBlock, uint256 originTxHash);

    constructor(uint256 originChainId_, address originContract_) payable {
        owner = msg.sender;
        originChainId = originChainId_;
        originContract = originContract_;
        SYSTEM.subscribe(
            originChainId_, originContract_, PING_TOPIC_0, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE
        );
    }

    /// @notice Recipients are set after deployment because callback contracts need this
    ///         contract's address at construction. A zero recipient disables that leg.
    function setRecipients(uint256 chainA_, address recipientA_, uint256 chainB_, address recipientB_) external {
        if (msg.sender != owner) revert NotOwner();
        destChainA = chainA_;
        recipientA = recipientA_;
        destChainB = chainB_;
        recipientB = recipientB_;
        emit RecipientsSet(chainA_, recipientA_, chainB_, recipientB_);
    }

    /// @notice Settles outstanding debt from this contract's own balance.
    function coverDebt() external {
        _coverDebt();
    }

    /// @inheritdoc IReactive
    /// @dev Never reverts on unmatched logs: reverts are still billed.
    function react(LogRecord calldata log_) external onlySystem {
        if (log_.topic0 != PING_TOPIC_0 || log_.opCode != 3) return;

        uint256 id = log_.topic1;
        bytes memory payload = abi.encodeWithSignature(
            "onPing(address,uint256,uint256,uint256,uint256)",
            address(0),
            id,
            log_.chainId,
            log_.blockNumber,
            log_.txHash
        );

        if (recipientA != address(0)) _request(destChainA, recipientA, payload);
        if (recipientB != address(0)) _request(destChainB, recipientB, payload);

        emit Relayed(id, log_.blockNumber, log_.txHash);
    }

    function _request(uint256 chainId_, address recipient_, bytes memory payload_) internal {
        SYSTEM.requestCallbackV_1_0(
            ISystemContract.CallbackConfiguration_V_1_0({
                chainId: chainId_, recipient: recipient_, gasLimit: CALLBACK_GAS_LIMIT, payload: payload_
            })
        );
    }
}
