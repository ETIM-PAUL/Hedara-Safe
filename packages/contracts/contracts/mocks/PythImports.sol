// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Pulls the Pyth SDK's MockPyth into the compile graph for the test suite — nothing in our own
// contracts imports the mock (only the real IPyth interface), so without this Hardhat never
// produces an artifact for it. Not part of the deployed template.
// solhint-disable-next-line no-global-import
import "@pythnetwork/pyth-sdk-solidity/MockPyth.sol";
