// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPriceOracleAdapter} from "../oracle/IPriceOracleAdapter.sol";

/// @notice Directly settable IPriceOracleAdapter — used to test PriceGuardedRebalanceModule's
/// own logic (condition checks, staleness, oracle switching) in isolation from any real
/// oracle's wire format. Not part of the deployed template.
contract MockOracleAdapter is IPriceOracleAdapter {
    int64 public price;
    int32 public expo;
    uint256 public publishTime;
    uint256 public mockFee;
    uint256 public refreshCallCount;

    function setPrice(int64 _price, int32 _expo, uint256 _publishTime) external {
        price = _price;
        expo = _expo;
        publishTime = _publishTime;
    }

    function setRefreshFee(uint256 _fee) external {
        mockFee = _fee;
    }

    function getPrice() external view returns (int64, int32, uint256) {
        return (price, expo, publishTime);
    }

    function refreshFee(bytes[] calldata) external view returns (uint256 fee) {
        return mockFee;
    }

    function refresh(bytes[] calldata) external payable {
        refreshCallCount += 1;
        require(msg.value >= mockFee, "insufficient fee");
    }
}
