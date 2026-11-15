// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// =============================================================================
//  NOT FOR DEPLOYMENT: requires legal opinions (see docs/karma-decisions.md 1.2)
// =============================================================================
//
//  This is a design draft, kept in the repository so the bridge can be reviewed
//  early. It must not be deployed to any network, testnet included, until:
//
//    1. Swiss, EU (MiCA) and US opinions have been obtained on UAIN credits as a
//       transferable crypto-asset (docs/karma-decisions.md 1.2, 2.4);
//    2. there is sustained, real usage of credits inside the network; and
//    3. the team has signed off on the bridge operator arrangement.
//
//  What it deliberately does NOT do, and why:
//    - No owner mint and no pre-mint. Credits only ever exist because verified
//      work settled on the UAIN ledger (decision 2.2); on-chain supply is only
//      ever a mirror of credits that were burned off-chain.
//    - No cap (decision 2.3: no cap, rule-bound issuance). The rules live in
//      the ledger, not here.
//    - No fee share, no dividends, no staking yield. Anything that routes
//      protocol revenue to holders is the asset-token pattern counsel will
//      object to.
//    - Credibility never comes on-chain. It is non-transferable by design
//      (decision 1.1); only credits bridge.
// =============================================================================

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title UAINCredits (DRAFT, NOT FOR DEPLOYMENT)
/// @notice The on-chain mirror of UAIN credits. Tokens exist only while the
///         same amount is held burned on the off-chain ledger.
contract UAINCredits is ERC20, AccessControl {
    /// @notice The bridge operator. It may mint only against a burn it has
    ///         recorded on the UAIN ledger, and names that burn in the event.
    bytes32 public constant BRIDGE_ROLE = keccak256("BRIDGE_ROLE");

    /// @notice Ledger references already used to mint, so one off-chain burn
    ///         can never be minted twice.
    mapping(bytes32 ledgerRef => bool) public minted;

    /// @notice Tokens minted against an off-chain burn.
    /// @param to Recipient address.
    /// @param amount Tokens minted, equal to the credits burned off-chain.
    /// @param ledgerRef Hash identifying the burn entry on the UAIN ledger.
    event BridgedIn(address indexed to, uint256 amount, bytes32 indexed ledgerRef);

    /// @notice Tokens burned here to be re-credited on the UAIN ledger.
    /// @param from Holder that burned.
    /// @param amount Tokens burned.
    /// @param uainParticipantId UAIN participant id to credit, e.g. "claude-code".
    event BridgedOut(address indexed from, uint256 amount, string uainParticipantId);

    error LedgerRefAlreadyMinted(bytes32 ledgerRef);
    error EmptyLedgerRef();
    error EmptyParticipant();
    error ZeroAmount();

    /// @param admin Holder of DEFAULT_ADMIN_ROLE, which grants and revokes the
    ///        bridge role. It receives no tokens and has no mint power itself.
    /// @param bridge Initial bridge operator.
    constructor(address admin, address bridge) ERC20("UAIN Credits", "UAINC") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(BRIDGE_ROLE, bridge);
    }

    /// @notice Mint tokens against credits burned on the UAIN ledger.
    /// @dev The only path to new supply. `ledgerRef` is the hash of the burn
    ///      entry on the hash-chained ledger, so the mint is auditable against
    ///      the daily roots anchored in LedgerAnchor.
    function bridgeIn(address to, uint256 amount, bytes32 ledgerRef)
        external
        onlyRole(BRIDGE_ROLE)
    {
        if (amount == 0) revert ZeroAmount();
        if (ledgerRef == bytes32(0)) revert EmptyLedgerRef();
        if (minted[ledgerRef]) revert LedgerRefAlreadyMinted(ledgerRef);
        minted[ledgerRef] = true;
        _mint(to, amount);
        emit BridgedIn(to, amount, ledgerRef);
    }

    /// @notice Burn tokens so the same amount is credited back on the UAIN
    ///         ledger to `uainParticipantId`. Anyone may bridge their own
    ///         tokens back.
    function burnToLedger(uint256 amount, string calldata uainParticipantId) external {
        if (amount == 0) revert ZeroAmount();
        if (bytes(uainParticipantId).length == 0) revert EmptyParticipant();
        _burn(msg.sender, amount);
        emit BridgedOut(msg.sender, amount, uainParticipantId);
    }
}
