// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ISafe} from "../interfaces/ISafe.sol";

/// @notice Test double standing in for a real Safe. Not part of the deployed template —
/// used only by the Phase 6 test suite to exercise RebalanceModule in isolation.
contract MockSafe is ISafe {
    mapping(address => bool) public owners;
    mapping(address => bool) public enabledModules;

    constructor() {
        owners[msg.sender] = true;
    }

    function setOwner(address owner, bool isOwner_) external {
        owners[owner] = isOwner_;
    }

    function isOwner(address owner) external view returns (bool) {
        return owners[owner];
    }

    /// @dev Mirrors real Safe's enableModule — a module must be enabled before it can call
    /// execTransactionFromModule, same as production.
    function enableModule(address module) external {
        enabledModules[module] = true;
    }

    function execTransactionFromModule(
        address to,
        uint256 value,
        bytes calldata data,
        Operation
    ) external returns (bool success) {
        require(enabledModules[msg.sender], "MockSafe: module not enabled");
        (success, ) = to.call{value: value}(data);
    }

    function execTransactionFromModuleReturnData(
        address to,
        uint256 value,
        bytes calldata data,
        Operation
    ) external returns (bool success, bytes memory returnData) {
        require(enabledModules[msg.sender], "MockSafe: module not enabled");
        (success, returnData) = to.call{value: value}(data);
    }
}
