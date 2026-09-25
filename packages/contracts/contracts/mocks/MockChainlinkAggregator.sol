// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal settable stand-in for a Chainlink AggregatorV3Interface feed, matching the
/// shape ChainlinkPriceAdapter reads. Not part of the deployed template.
contract MockChainlinkAggregator {
    int256 public answer;
    uint8 public decimals;
    uint256 public updatedAt;

    constructor(int256 _answer, uint8 _decimals, uint256 _updatedAt) {
        answer = _answer;
        decimals = _decimals;
        updatedAt = _updatedAt;
    }

    function set(int256 _answer, uint256 _updatedAt) external {
        answer = _answer;
        updatedAt = _updatedAt;
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer_, uint256 startedAt, uint256 updatedAt_, uint80 answeredInRound)
    {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}
