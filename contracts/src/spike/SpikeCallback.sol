// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IPayable} from "@reactive/src/interfaces/IPayable.sol";
import {AbstractCallback} from "@reactive/src/base/AbstractCallback.sol";

/// @title SpikeCallback
/// @notice Destination-side contract for the latency spike. Emits the origin metadata
///         so an off-chain script can join origin, reactive and destination transactions.
contract SpikeCallback is AbstractCallback {
    event Handled(
        uint256 indexed id, uint256 originChainId, uint256 originBlock, bytes32 originTxHash, uint256 handledAt
    );

    uint256 public lastId;

    constructor(IPayable callbackProxy_, address callbackSender_)
        payable
        AbstractCallback(callbackProxy_, callbackSender_)
    {}

    function onPing(address reactive_, uint256 id_, uint256 originChainId_, uint256 originBlock_, uint256 originTxHash_)
        external
        onlyServiceProvider
        onlyCallbackSender(reactive_)
    {
        lastId = id_;
        emit Handled(id_, originChainId_, originBlock_, bytes32(originTxHash_), block.timestamp);
    }

    /// @notice Settles outstanding debt from this contract's own balance.
    function coverDebt() external {
        _coverDebt();
    }
}
