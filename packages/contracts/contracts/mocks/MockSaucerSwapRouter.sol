// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ISaucerSwapRouter} from "../interfaces/ISaucerSwapRouter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Test double standing in for the SaucerSwap router. Swaps 1:1 out of its own balance —
/// deterministic and enough to exercise RebalanceModule's call path. Not part of the deployed
/// template.
contract MockSaucerSwapRouter is ISaucerSwapRouter {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts) {
        require(deadline >= block.timestamp, "MockRouter: expired");
        require(path.length == 2, "MockRouter: bad path");

        IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);

        // 1:1 swap — reverts on insufficient router liquidity, standing in for a real
        // slippage/liquidity failure.
        uint256 amountOut = amountIn;
        require(amountOut >= amountOutMin, "MockRouter: insufficient output");
        IERC20(path[1]).transfer(to, amountOut);

        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = amountOut;
    }
}
