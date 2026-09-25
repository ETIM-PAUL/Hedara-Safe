// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Hardhat only compiles what's inside contracts/ (or reachable from it). This
// file exists solely to pull the vendored Safe contracts into that graph so
// their artifacts are available to scripts/deploy.ts. Not part of the
// template's own logic — see AGENTS.md: don't hand-edit the Safe core.
import "@safe-global/safe-contracts/contracts/Safe.sol";
import "@safe-global/safe-contracts/contracts/proxies/SafeProxyFactory.sol";
