// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal SaucerSwap router interface — only the swap path this module uses.
interface ISaucerSwapRouter {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}
