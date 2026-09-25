// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Common surface PriceGuardedRebalanceModule talks to, regardless of which oracle
/// backs it (Chainlink, Supra, or a future one). Letting the Safe owner call setOracle() with a
/// different adapter address is the entire switching mechanism — the module never branches on
/// which provider is active.
interface IPriceOracleAdapter {
    /// @return price The price, scaled by 10**expo.
    /// @return expo The power-of-ten exponent (typically negative, e.g. -8).
    /// @return publishTime Unix timestamp the price was last updated.
    function getPrice() external view returns (int64 price, int32 expo, uint256 publishTime);

    /// @notice The exact fee refresh() will need for this updateData. Callers must check this
    /// (and forward exactly this much) *before* calling refresh — keeping fee lookup and fee
    /// payment separate is what lets a caller safely forward only what's needed and refund the
    /// rest, since refresh() itself has no way to know how much of msg.value beyond its own fee
    /// belongs to something else.
    function refreshFee(bytes[] calldata updateData) external view returns (uint256 fee);

    /// @notice Refreshes the underlying price before it's read, for pull-model oracles (Pyth)
    /// that need fresh off-chain data submitted in the same transaction. Push-model oracles
    /// (Chainlink, Supra) are already kept fresh by their own network and implement this as a
    /// true no-op. Callers should send exactly refreshFee(updateData), no more.
    function refresh(bytes[] calldata updateData) external payable;
}
