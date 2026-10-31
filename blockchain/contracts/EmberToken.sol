// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

contract EmberToken is ERC20, AccessControl {
    error ZeroAddress();
    error ZeroMaxSupply();
    error InitialAllocationExceedsMaxSupply(uint256 requested, uint256 maxSupply);
    error MaxSupplyExceeded(uint256 requestedTotal, uint256 maxSupply);
    error MintNotToTreasury(address requestedTo);

    event TokensMinted(address indexed to, uint256 amount, uint256 newTotalSupply);
    event TokensBurned(address indexed from, uint256 amount, uint256 newTotalSupply);
    event TreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);

    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");

    uint256 public immutable maxSupply;
    address public treasury;

    constructor(
        address initialAdmin,
        address initialTreasury,
        uint256 maxSupply_,
        uint256 initialTreasuryAllocation
    ) ERC20("Ember", "EMBER") {
        if (initialAdmin == address(0)) revert ZeroAddress();
        if (initialTreasury == address(0)) revert ZeroAddress();
        if (maxSupply_ == 0) revert ZeroMaxSupply();
        if (initialTreasuryAllocation > maxSupply_) {
            revert InitialAllocationExceedsMaxSupply(initialTreasuryAllocation, maxSupply_);
        }

        maxSupply = maxSupply_;
        treasury = initialTreasury;
        _grantRole(DEFAULT_ADMIN_ROLE, initialAdmin);
        _mintAuthorized(initialTreasuryAllocation);
    }

    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        if (to != treasury) revert MintNotToTreasury(to);
        _mintAuthorized(amount);
    }

    function burnTreasury(uint256 amount) external onlyRole(BURNER_ROLE) {
        _burn(treasury, amount);
        emit TokensBurned(treasury, amount, totalSupply());
    }

    function setTreasury(address newTreasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newTreasury == address(0)) revert ZeroAddress();
        address previous = treasury;
        treasury = newTreasury;
        emit TreasuryUpdated(previous, newTreasury);
    }

    function _mintAuthorized(uint256 amount) private {
        _mint(treasury, amount);
        emit TokensMinted(treasury, amount, totalSupply());
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) && to == treasury) {
            uint256 requestedTotal = totalSupply() + value;
            if (requestedTotal > maxSupply) {
                revert MaxSupplyExceeded(requestedTotal, maxSupply);
            }
        }
        super._update(from, to, value);
    }
}
