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

    error NotSafeOwner();
    error SwapFailed();
    error ZeroAmount();
    error DeadlinePassed();

    constructor(address _safe, address _router) {
        safe = ISafe(_safe);
        router = ISaucerSwapRouter(_router);
    }

    modifier onlySafeOwner() {
        if (!safe.isOwner(msg.sender)) revert NotSafeOwner();
        _;
    }

    /// @notice Swap `amountIn` of `tokenIn` held by the Safe for `tokenOut` via SaucerSwap.
    /// @param amountOutMin Minimum acceptable output — caller-supplied slippage bound.
    /// @param deadline Unix timestamp after which the swap must revert, not execute stale.
    function rebalance(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 deadline
    ) external onlySafeOwner returns (uint256 amountOut) {
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
