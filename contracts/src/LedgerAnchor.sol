// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title LedgerAnchor
/// @notice Publishes one fingerprint of the UAIN ledger per day, and never
///         lets it be changed.
/// @dev The UAIN ledger lives off-chain, in the connection server's store. It is
///      hash-chained and every day gets a Merkle root over that day's entries,
///      signed by the server key. That is enough for anyone to check that the
///      ledger they are shown is internally consistent, but not enough to stop
///      the operator from rewriting history and re-signing it.
///
///      This contract closes that gap. Once a day's root is anchored here it
///      cannot be overwritten, and days only move forward. From that point, any
///      rewrite of an entry on or before an anchored day produces a root that
///      disagrees with the chain, and anyone can prove it with the public
///      `verify-ledger` script. The operator can still choose not to anchor, or
///      anchor late; it can never anchor twice or go back.
///
///      Nothing personal is stored: only hashes, counts and ids. Contribution
///      text, participant names and operators stay off-chain.
///
///      No upgradeability, no proxy, no pause, no admin override of an anchor.
contract LedgerAnchor {
    /// @notice One anchored day.
    struct Anchor {
        /// Merkle root over the hashes of every ledger entry recorded that UTC day.
        bytes32 root;
        /// Hash-chain head after the last entry of that day.
        bytes32 head;
        /// Number of ledger entries in the day.
        uint64 count;
        /// Id of the last ledger entry in the day.
        uint64 lastEventId;
        /// Block timestamp at which the anchor was written.
        uint64 anchoredAt;
    }

    /// @notice May rotate the anchorer, and do nothing else.
    address public immutable owner;

    /// @notice The only address allowed to write anchors.
    address public anchorer;

    /// @notice The most recent day anchored, as days since the Unix epoch.
    ///         Zero means nothing has been anchored yet.
    uint32 public lastDay;

    mapping(uint32 day => Anchor) private anchors;

    /// @notice Emitted once per day, when that day's root is fixed forever.
    event Anchored(
        uint32 indexed day,
        bytes32 root,
        bytes32 head,
        uint64 count,
        uint64 lastEventId
    );

    /// @notice Emitted when the owner replaces the anchorer. Past anchors are
    ///         unaffected: a new key can only add days, never touch old ones.
    event AnchorerRotated(address indexed previous, address indexed next);

    error NotOwner();
    error NotAnchorer();
    error AlreadyAnchored(uint32 day);
    error DayNotAfterLast(uint32 day, uint32 lastDay);
    error EmptyRoot();
    error EmptyHead();
    error DayNotCompleted();
    error InvalidEventRange();
    error ZeroAddress();

    /// @param initialAnchorer Key used by the UAIN operator to post daily roots.
    constructor(address initialAnchorer) {
        if (initialAnchorer == address(0)) revert ZeroAddress();
        owner = msg.sender;
        anchorer = initialAnchorer;
        emit AnchorerRotated(address(0), initialAnchorer);
    }

    /// @notice Fix a day's ledger root. Callable once per day, in increasing
    ///         day order, by the anchorer only.
    /// @dev Strictly increasing days is what makes the anchor append-only: a
    ///      skipped day can never be filled in afterwards, so there is no window
    ///      in which an old day could be anchored with a rewritten root.
    /// @param day Days since the Unix epoch (UTC) of the ledger day.
    /// @param root Merkle root of that day's entry hashes.
    /// @param head Hash-chain head after that day's last entry.
    /// @param count Number of entries in the day.
    /// @param lastEventId Id of the day's last entry.
    function anchor(
        uint32 day,
        bytes32 root,
        bytes32 head,
        uint64 count,
        uint64 lastEventId
    ) external {
        if (msg.sender != anchorer) revert NotAnchorer();
        if (root == bytes32(0)) revert EmptyRoot();
        if (head == bytes32(0)) revert EmptyHead();
        if (anchors[day].anchoredAt != 0) revert AlreadyAnchored(day);
        if (day <= lastDay) revert DayNotAfterLast(day, lastDay);
        if (uint256(day) >= block.timestamp / 1 days) revert DayNotCompleted();
        uint64 previousId = anchors[lastDay].lastEventId;
        if (count == 0 || lastEventId <= previousId || count > lastEventId - previousId) {
            revert InvalidEventRange();
        }

        anchors[day] = Anchor({
            root: root,
            head: head,
            count: count,
            lastEventId: lastEventId,
            anchoredAt: uint64(block.timestamp)
        });
        lastDay = day;
        emit Anchored(day, root, head, count, lastEventId);
    }

    /// @notice The root anchored for a day, or zero if the day was never anchored.
    function rootOf(uint32 day) external view returns (bytes32) {
        return anchors[day].root;
    }

    /// @notice Everything anchored for a day. `anchoredAt` is zero if never anchored.
    function anchorOf(uint32 day) external view returns (Anchor memory) {
        return anchors[day];
    }

    /// @notice Replace the anchorer key, for example after a key is lost or
    ///         leaked. It grants no power over anchors already written.
    function rotateAnchorer(address next) external {
        if (msg.sender != owner) revert NotOwner();
        if (next == address(0)) revert ZeroAddress();
        emit AnchorerRotated(anchorer, next);
        anchorer = next;
    }
}
