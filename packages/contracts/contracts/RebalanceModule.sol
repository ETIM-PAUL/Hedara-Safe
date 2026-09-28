// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ISafe} from "./interfaces/ISafe.sol";
import {ISaucerSwapRouter} from "./interfaces/ISaucerSwapRouter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Safe module that lets an owner trigger a treasury rebalance through the SaucerSwap
/// router. Scoped to a single Safe and a single router — no arbitrary target allowlist.
contract RebalanceModule {
    ISafe public immutable safe;
    ISaucerSwapRouter public immutable router;

    event Rebalanced(
        address indexed triggeredBy,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );

    error NotSafe();
    error SwapFailed();
    error ZeroAmount();
    error DeadlinePassed();

    constructor(address _safe, address _router) {
        safe = ISafe(_safe);
        router = ISaucerSwapRouter(_router);
    }

    /// @dev Requires the call to originate from the Safe itself — i.e. from a quorum-approved
    /// `execTransaction`, not any single owner calling this module directly. This is what makes
    /// rebalances require the Safe's configured threshold of signatures rather than any one
    /// owner acting alone; see AGENTS.md for why this differs from PriceGuardedRebalanceModule's
    /// `onlySafeOwner` (single-owner) gating.
    modifier onlySafe() {
        if (msg.sender != address(safe)) revert NotSafe();
        _;
    }

    /// @notice Swap `amountIn` of `tokenIn` held by the Safe for `tokenOut` via SaucerSwap.
    /// @dev Callable only by the Safe itself — an owner (or set of owners meeting the threshold)
    /// must submit this as a Safe transaction (`to` = this module, `data` = this call) via
    /// `execTransaction`, not call it directly from their own account.
    /// @param amountOutMin Minimum acceptable output — caller-supplied slippage bound.
    /// @param deadline Unix timestamp after which the swap must revert, not execute stale.
    function rebalance(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 deadline
    ) external onlySafe returns (uint256 amountOut) {
        if (amountIn == 0) revert ZeroAmount();
        if (deadline < block.timestamp) revert DeadlinePassed();

        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;

        bool approved = safe.execTransactionFromModule(
            tokenIn,
            0,
            abi.encodeCall(IERC20.approve, (address(router), amountIn)),
            ISafe.Operation.Call
        );
        if (!approved) revert SwapFailed();

        bytes memory swapCalldata = abi.encodeCall(
            ISaucerSwapRouter.swapExactTokensForTokens,
            (amountIn, amountOutMin, path, address(safe), deadline)
        );

        (bool swapped, bytes memory returnData) = safe.execTransactionFromModuleReturnData(
            address(router),
            0,
            swapCalldata,
            ISafe.Operation.Call
        );
        if (!swapped) revert SwapFailed();

        uint256[] memory amounts = abi.decode(returnData, (uint256[]));
        amountOut = amounts[amounts.length - 1];

        emit Rebalanced(msg.sender, tokenIn, tokenOut, amountIn, amountOut);
        return amountOut;
    }
}
