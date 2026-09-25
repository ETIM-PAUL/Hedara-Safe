// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ISafe} from "./interfaces/ISafe.sol";
import {ISaucerSwapRouter} from "./interfaces/ISaucerSwapRouter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPriceOracleAdapter} from "./oracle/IPriceOracleAdapter.sol";

/// @notice Safe module that only rebalances when a live oracle price condition holds. The Safe
/// owner sets the trigger and can switch the oracle backing it (setOracle) between any deployed
/// IPriceOracleAdapter — Chainlink, Supra, or a future one — without redeploying this module or
/// losing its configured condition. Calling trigger() itself is permissionless (any keeper/bot
/// can fire it) since the price condition is the guard, not the caller — the swap only ever
/// moves the Safe's own funds, through the same execTransactionFromModule pattern as
/// RebalanceModule. Deliberately a separate contract from RebalanceModule (AGENTS.md: one
/// module = one responsibility) rather than bolting price-gating onto the manual swap path.
contract PriceGuardedRebalanceModule is ReentrancyGuard {
    enum Comparison {
        Below,
        Above
    }

    ISafe public immutable safe;
    ISaucerSwapRouter public immutable router;

    IPriceOracleAdapter public oracle;
    int64 public triggerPrice;
    int32 public triggerExpo;
    Comparison public comparison;
    uint256 public maxPriceAgeSeconds;

    event OracleChanged(address indexed oracle);
    event TriggerConfigured(
        int64 triggerPrice,
        int32 triggerExpo,
        Comparison comparison,
        uint256 maxPriceAgeSeconds
    );
    event Rebalanced(
        address indexed triggeredBy,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        int64 observedPrice,
        int32 observedExpo
    );

    error NotSafeOwner();
    error SwapFailed();
    error ZeroAmount();
    error DeadlinePassed();
    error InsufficientFee();
    error RefundFailed();
    error StalePrice(uint256 publishTime, uint256 maxAge);
    error PriceConditionNotMet(int64 observedPrice, int32 observedExpo, int64 triggerPrice, int32 triggerExpo);

    constructor(
        address _safe,
        address _router,
        address _oracle,
        int64 _triggerPrice,
        int32 _triggerExpo,
        Comparison _comparison,
        uint256 _maxPriceAgeSeconds
    ) {
        safe = ISafe(_safe);
        router = ISaucerSwapRouter(_router);
        oracle = IPriceOracleAdapter(_oracle);
        triggerPrice = _triggerPrice;
        triggerExpo = _triggerExpo;
        comparison = _comparison;
        maxPriceAgeSeconds = _maxPriceAgeSeconds;
    }

    modifier onlySafeOwner() {
        if (!safe.isOwner(msg.sender)) revert NotSafeOwner();
        _;
    }

    /// @notice Owner switches which oracle backs this module — e.g. Chainlink to Supra — without
    /// touching the configured trigger condition or redeploying.
    function setOracle(address _oracle) external onlySafeOwner {
        _setOracle(_oracle);
    }

    /// @notice Owner reconfigures the trigger condition. Not speculative — the price target is
    /// the entire point of this module, and it needs to move as market conditions change.
    function setTrigger(
        int64 _triggerPrice,
        int32 _triggerExpo,
        Comparison _comparison,
        uint256 _maxPriceAgeSeconds
    ) external onlySafeOwner {
        triggerPrice = _triggerPrice;
        triggerExpo = _triggerExpo;
        comparison = _comparison;
        maxPriceAgeSeconds = _maxPriceAgeSeconds;
        emit TriggerConfigured(_triggerPrice, _triggerExpo, _comparison, _maxPriceAgeSeconds);
    }

    /// @notice Refreshes the active oracle (a no-op for the push-model oracles this module
    /// targets — Chainlink, Supra), checks the observed price against the configured trigger,
    /// and — only if the condition holds — swaps tokenIn for tokenOut through SaucerSwap.
    /// Permissionless: the price condition is the guard, not the caller, so anyone can call this
    /// with whatever oracle is currently set. It deliberately cannot choose the oracle itself —
    /// see switchOracleAndTrigger for why that has to stay owner-only.
    function trigger(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 deadline,
        bytes[] calldata updateData
    ) external payable nonReentrant returns (uint256 amountOut) {
        return _trigger(tokenIn, tokenOut, amountIn, amountOutMin, deadline, updateData);
    }

    /// @notice Owner convenience: switches the active oracle and fires a trigger in one signed
    /// transaction instead of two. Restricted to the Safe owner for the same reason setOracle is
    /// — if a permissionless caller could pick which oracle backs the check, they could point it
    /// at a contract that always reports the condition as met, defeating the guard entirely. The
    /// plain permissionless trigger() above never gets this option; only the owner does.
    function switchOracleAndTrigger(
        address newOracle,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 deadline,
        bytes[] calldata updateData
    ) external payable nonReentrant onlySafeOwner returns (uint256 amountOut) {
        if (newOracle != address(oracle)) {
            _setOracle(newOracle);
        }
        return _trigger(tokenIn, tokenOut, amountIn, amountOutMin, deadline, updateData);
    }

    function _setOracle(address _oracle) internal {
        oracle = IPriceOracleAdapter(_oracle);
        emit OracleChanged(_oracle);
    }

    function _trigger(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 deadline,
        bytes[] calldata updateData
    ) internal returns (uint256 amountOut) {
        if (amountIn == 0) revert ZeroAmount();
        if (deadline < block.timestamp) revert DeadlinePassed();

        uint256 fee = oracle.refreshFee(updateData);
        if (msg.value < fee) revert InsufficientFee();
        oracle.refresh{value: fee}(updateData);

        (int64 observedPrice, int32 observedExpo, uint256 publishTime) = oracle.getPrice();
        if (diff(block.timestamp, publishTime) > maxPriceAgeSeconds) {
            revert StalePrice(publishTime, maxPriceAgeSeconds);
        }
        if (!conditionHolds(observedPrice, observedExpo)) {
            revert PriceConditionNotMet(observedPrice, observedExpo, triggerPrice, triggerExpo);
        }

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

        emit Rebalanced(msg.sender, tokenIn, tokenOut, amountIn, amountOut, observedPrice, observedExpo);

        // Refund last, after every state-changing external call — checks-effects-interactions.
        if (msg.value > fee) {
            (bool refunded, ) = msg.sender.call{value: msg.value - fee}("");
            if (!refunded) revert RefundFailed();
        }

        return amountOut;
    }

    function conditionHolds(int64 observedPrice, int32 observedExpo) internal view returns (bool) {
        (int256 normalizedObserved, int256 normalizedTrigger) = normalize(
            observedPrice,
            observedExpo,
            triggerPrice,
            triggerExpo
        );
        if (comparison == Comparison.Below) {
            return normalizedObserved <= normalizedTrigger;
        }
        return normalizedObserved >= normalizedTrigger;
    }

    /// @dev Oracle exponents can differ between providers (and between updates); scale both
    /// prices to the finer of the two exponents before comparing so switching oracles — or a
    /// stale trigger config — never silently miscompares.
    function normalize(
        int64 priceA,
        int32 expoA,
        int64 priceB,
        int32 expoB
    ) internal pure returns (int256, int256) {
        if (expoA == expoB) {
            return (int256(priceA), int256(priceB));
        }
        if (expoA < expoB) {
            uint256 scale = 10 ** uint32(expoB - expoA);
            return (int256(priceA), int256(priceB) * int256(scale));
        } else {
            uint256 scale = 10 ** uint32(expoA - expoB);
            return (int256(priceA) * int256(scale), int256(priceB));
        }
    }

    function diff(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : b - a;
    }
}
