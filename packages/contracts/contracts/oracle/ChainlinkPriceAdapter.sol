// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPriceOracleAdapter} from "./IPriceOracleAdapter.sol";

/// @notice Minimal Chainlink AggregatorV3Interface — only what this adapter needs.
interface IAggregatorV3 {
    function decimals() external view returns (uint8);

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @notice Adapts a Chainlink price feed to IPriceOracleAdapter. Chainlink is push-model —
/// Chainlink's own network keeps `latestRoundData()` fresh, so refresh() is a genuine no-op:
/// there's no update to push and no fee to pay, unlike a pull-model oracle would require.
contract ChainlinkPriceAdapter is IPriceOracleAdapter {
    IAggregatorV3 public immutable feed;

    error PriceOutOfRange(int256 answer);

    constructor(address _feed) {
        feed = IAggregatorV3(_feed);
    }

    function getPrice() external view returns (int64 price, int32 expo, uint256 publishTime) {
        (, int256 answer, , uint256 updatedAt, ) = feed.latestRoundData();
        if (answer > type(int64).max || answer < type(int64).min) revert PriceOutOfRange(answer);
        uint8 decimals = feed.decimals();
        return (int64(answer), -int32(uint32(decimals)), updatedAt);
    }

    /// @dev No-op: Chainlink is already fresh, no fee is ever charged.
    function refreshFee(bytes[] calldata) external pure returns (uint256 fee) {
        return 0;
    }

    /// @dev No-op: Chainlink is already fresh. updateData is ignored.
    // solhint-disable-next-line no-empty-blocks
    function refresh(bytes[] calldata) external payable {}
}
