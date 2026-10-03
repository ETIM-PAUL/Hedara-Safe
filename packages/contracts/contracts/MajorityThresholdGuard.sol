// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseGuard} from "@safe-global/safe-contracts/contracts/base/GuardManager.sol";
import {Enum} from "@safe-global/safe-contracts/contracts/common/Enum.sol";

interface ISafeQuorum {
    function getThreshold() external view returns (uint256);

    function getOwners() external view returns (address[] memory);
}

/// @title MajorityThresholdGuard
/// @notice Safe transaction guard (set via `Safe.setGuard`) that keeps a strict majority of owners
///         in charge: after every `execTransaction`, the Safe's threshold must be at least
///         `owners / 2 + 1` (2 of 3, 3 of 4, 3 of 5, 4 of 6), or the whole transaction reverts.
/// @dev Stateless and Safe-agnostic — it reads whichever Safe is calling, so one deployment can
///      guard any number of Safes, and the vendored Safe core stays unmodified.
///      Checked after execution rather than by decoding calldata, so it covers every way to change
///      owners or threshold (addOwnerWithThreshold, removeOwner, swapOwner, changeThreshold,
///      multisend batches) without a list of selectors to keep in sync.
///      Safe 1.4.1 does not run guards on `execTransactionFromModule`; this template's modules can
///      only approve tokens and call the swap router, so they can't change owners, but a future
///      module that could would bypass this guard.
contract MajorityThresholdGuard is BaseGuard {
    error ThresholdBelowMajority(uint256 threshold, uint256 owners, uint256 required);

    function checkTransaction(
        address,
        uint256,
        bytes memory,
        Enum.Operation,
        uint256,
        uint256,
        uint256,
        address,
        address payable,
        bytes memory,
        address
        // solhint-disable-next-line no-empty-blocks
    ) external pure override {}

    /// @dev Also runs for the transaction that removes this guard (Safe reads the guard before
    ///      executing), so the guard can be removed only while the Safe is at a majority.
    function checkAfterExecution(bytes32, bool) external view override {
        ISafeQuorum safe = ISafeQuorum(msg.sender);
        uint256 owners = safe.getOwners().length;
        uint256 required = owners / 2 + 1;
        uint256 threshold = safe.getThreshold();
        if (threshold < required) revert ThresholdBelowMajority(threshold, owners, required);
    }
}
