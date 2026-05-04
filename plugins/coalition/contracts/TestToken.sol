// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title TestToken
/// @notice Minimal ERC-20 fixture for the Coalition e2e script.
/// @dev Anyone-mintable. For local and testnet integration testing only.
///      Not intended for production deployment.
contract TestToken is ERC20 {
    constructor() ERC20("Coalition Stake Test", "STAKE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
