// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPriceOracleAdapter} from "./IPriceOracleAdapter.sol";

/// @notice Minimal Supra push-oracle storage interface — only what this adapter needs.
interface ISupraSValueFeed {
    function getSvalue(
        uint256 _pairIndex
    ) external view returns (uint256 round, uint256 decimals, uint256 time, uint256 price);
}

/// @notice Adapts Supra's push oracle to IPriceOracleAdapter. Like Chainlink, Supra's own
/// network keeps the stored value fresh, so refresh() is a no-op. Two things this adapter
/// converts rather than forwards as-is: `price` is unsigned on the wire (unlike this interface's
/// signed `int64`), and `time` is Unix milliseconds, not seconds.
contract SupraPriceAdapter is IPriceOracleAdapter {
    ISupraSValueFeed public immutable oracle;
    uint256 public immutable pairIndex;

    error PriceOutOfRange(uint256 price);

    constructor(address _oracle, uint256 _pairIndex) {
        oracle = ISupraSValueFeed(_oracle);
        pairIndex = _pairIndex;
    }

    function getPrice() external view returns (int64 price, int32 expo, uint256 publishTime) {
        (, uint256 decimals, uint256 timeMs, uint256 rawPrice) = oracle.getSvalue(pairIndex);
        if (rawPrice > uint256(uint64(type(int64).max))) revert PriceOutOfRange(rawPrice);
        return (int64(uint64(rawPrice)), -int32(uint32(decimals)), timeMs / 1000);
    }

    /// @dev No-op: Supra is already fresh, no fee is ever charged.
    function refreshFee(bytes[] calldata) external pure returns (uint256 fee) {
        return 0;
    }

    /// @dev No-op: Supra is already fresh. updateData is ignored.
    // solhint-disable-next-line no-empty-blocks
    function refresh(bytes[] calldata) external payable {}
}
