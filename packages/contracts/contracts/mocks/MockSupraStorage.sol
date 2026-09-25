// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal settable stand-in for Supra's push-oracle storage contract, matching the
/// shape SupraPriceAdapter reads. Not part of the deployed template.
contract MockSupraStorage {
    uint256 public round;
    uint256 public decimals;
    uint256 public time; // unix milliseconds, matching Supra's real contract
    uint256 public price;

    constructor(uint256 _decimals, uint256 _time, uint256 _price) {
        decimals = _decimals;
        time = _time;
        price = _price;
        round = 1;
    }

    function set(uint256 _time, uint256 _price) external {
        time = _time;
        price = _price;
        round += 1;
    }

    function getSvalue(uint256) external view returns (uint256, uint256, uint256, uint256) {
        return (round, decimals, time, price);
    }
}
