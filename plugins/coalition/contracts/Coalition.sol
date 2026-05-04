// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Coalition
/// @notice Multi-party on-chain commitments with stake escrow and slashing.
/// @dev v1 design notes:
///  - `stakeToken` MUST be a standard ERC-20. Fee-on-transfer, deflationary,
///    and rebasing tokens are unsupported: `sign` credits the full
///    `stakePerParty` to bookkeeping without checking the actually-received
///    balance, so any short-receipt token leaves slash/dissolve/expire
///    unable to transfer the bookkept amount and reverts on the final
///    refunds. This is a known v1 limitation; see the project tracker for
///    the contract-change ticket that adds a balance-delta require.
///  - `recordBreach`, `slash`, and `expire` are anyone-callable; off-chain
///    arbitration is expected to gate breach evidence in production deployments.
///  - `dissolve` is restricted to participants to prevent griefing.
///  - Pro-rata math truncates dust into the contract when stake does not
///    divide evenly across recipients.
///  - When every participant has been breached, the last `slash` has no
///    eligible recipients; the breached party's stake remains in the contract
///    and the coalition transitions to SLASHED.
contract Coalition is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum State { NONE, PROPOSED, ACTIVE, DISSOLVED, SLASHED, EXPIRED }

    struct CoalitionData {
        bytes32 termsHash;
        address[] participants;
        address stakeToken;
        uint256 stakePerParty;
        uint256 deadline;
        uint8 signedCount;
        uint8 breachedCount;
        uint8 slashedCount;
        State state;
    }

    mapping(uint256 => CoalitionData) private _coalitions;
    mapping(uint256 => mapping(address => bool)) private _signed;
    mapping(uint256 => mapping(address => bool)) private _breached;
    mapping(uint256 => mapping(address => bool)) private _slashed;
    mapping(uint256 => mapping(address => bool)) private _isParticipant;

    uint256 public nextId = 1;

    uint8 public constant MIN_PARTICIPANTS = 2;
    uint8 public constant MAX_PARTICIPANTS = 20;

    error InvalidParticipantCount();
    error DeadlineInPast();
    error DuplicateParticipant();
    error ZeroStake();
    error CoalitionNotProposed();
    error CoalitionNotActive();
    error NotParticipant();
    error AlreadySigned();
    error NotAllSigned();
    error PartyNotBreached();
    error PartyAlreadyBreached();
    error PartyAlreadySlashed();
    error DeadlineNotReached();

    event Proposed(
        uint256 indexed id,
        bytes32 termsHash,
        address[] participants,
        address stakeToken,
        uint256 stakePerParty,
        uint256 deadline
    );
    event Signed(uint256 indexed id, address indexed participant);
    event Activated(uint256 indexed id);
    event Breach(uint256 indexed id, address indexed party, bytes32 evidenceHash);
    event Slashed(uint256 indexed id, address indexed party, uint256 amountRedistributed);
    event Dissolved(uint256 indexed id);
    event Expired(uint256 indexed id);

    function propose(
        address[] calldata participants,
        bytes32 termsHash,
        uint256 deadline,
        address stakeToken,
        uint256 stakePerParty
    ) external returns (uint256 id) {
        if (participants.length < MIN_PARTICIPANTS || participants.length > MAX_PARTICIPANTS) {
            revert InvalidParticipantCount();
        }
        if (deadline <= block.timestamp) revert DeadlineInPast();
        if (stakePerParty == 0) revert ZeroStake();

        id = nextId++;
        CoalitionData storage c = _coalitions[id];
        c.termsHash = termsHash;
        c.stakeToken = stakeToken;
        c.stakePerParty = stakePerParty;
        c.deadline = deadline;
        c.state = State.PROPOSED;

        for (uint256 i = 0; i < participants.length; i++) {
            address p = participants[i];
            if (_isParticipant[id][p]) revert DuplicateParticipant();
            _isParticipant[id][p] = true;
            c.participants.push(p);
        }

        emit Proposed(id, termsHash, participants, stakeToken, stakePerParty, deadline);
    }

    function sign(uint256 id) external nonReentrant {
        CoalitionData storage c = _coalitions[id];
        if (c.state != State.PROPOSED) revert CoalitionNotProposed();
        if (!_isParticipant[id][msg.sender]) revert NotParticipant();
        if (_signed[id][msg.sender]) revert AlreadySigned();

        _signed[id][msg.sender] = true;
        c.signedCount += 1;

        IERC20(c.stakeToken).safeTransferFrom(msg.sender, address(this), c.stakePerParty);

        emit Signed(id, msg.sender);
    }

    function activate(uint256 id) external {
        CoalitionData storage c = _coalitions[id];
        if (c.state != State.PROPOSED) revert CoalitionNotProposed();
        if (c.signedCount != c.participants.length) revert NotAllSigned();

        c.state = State.ACTIVE;
        emit Activated(id);
    }

    function recordBreach(uint256 id, address party, bytes32 evidenceHash) external {
        CoalitionData storage c = _coalitions[id];
        if (c.state != State.ACTIVE) revert CoalitionNotActive();
        if (!_isParticipant[id][party]) revert NotParticipant();
        if (_breached[id][party]) revert PartyAlreadyBreached();

        _breached[id][party] = true;
        c.breachedCount += 1;

        emit Breach(id, party, evidenceHash);
    }

    /// @notice Slash a breached party's stake pro-rata across non-breached participants.
    /// @dev `_breached` and `_slashed` are both permanent flags. `_breached` is set on
    ///      `recordBreach` and never reset. `_slashed` is set here and never reset, used
    ///      to enforce single-slash-per-party. Recipients are participants who are
    ///      neither the slashed party, breached, nor slashed. When every party has been
    ///      breached, the last `slash` has zero recipients and the stake remains in
    ///      the contract; the coalition transitions to SLASHED on the final slash.
    function slash(uint256 id, address party) external nonReentrant returns (uint256 amountRedistributed) {
        CoalitionData storage c = _coalitions[id];
        if (c.state != State.ACTIVE) revert CoalitionNotActive();
        if (!_breached[id][party]) revert PartyNotBreached();
        if (_slashed[id][party]) revert PartyAlreadySlashed();

        _slashed[id][party] = true;
        c.slashedCount += 1;

        // Count eligible recipients first so share is exact and known to be safe.
        uint256 recipientCount = 0;
        uint256 participantsLen = c.participants.length;
        for (uint256 i = 0; i < participantsLen; i++) {
            address p = c.participants[i];
            if (p == party) continue;
            if (_breached[id][p]) continue;
            recipientCount += 1;
        }

        if (recipientCount > 0) {
            uint256 share = c.stakePerParty / recipientCount;
            amountRedistributed = share * recipientCount;

            IERC20 token = IERC20(c.stakeToken);
            for (uint256 i = 0; i < participantsLen; i++) {
                address p = c.participants[i];
                if (p == party) continue;
                if (_breached[id][p]) continue;
                token.safeTransfer(p, share);
            }
        }
        // If recipientCount == 0 (every other party is breached), amountRedistributed
        // stays at 0 and the slashed stake remains in the contract.

        if (c.slashedCount == participantsLen) {
            c.state = State.SLASHED;
        }

        emit Slashed(id, party, amountRedistributed);
    }

    /// @notice Clean close of an active coalition. Returns each non-breached
    ///         participant's stake. Restricted to participants to prevent griefing.
    function dissolve(uint256 id) external nonReentrant {
        CoalitionData storage c = _coalitions[id];
        if (c.state != State.ACTIVE) revert CoalitionNotActive();
        if (!_isParticipant[id][msg.sender]) revert NotParticipant();

        c.state = State.DISSOLVED;
        IERC20 token = IERC20(c.stakeToken);
        uint256 participantsLen = c.participants.length;
        for (uint256 i = 0; i < participantsLen; i++) {
            address p = c.participants[i];
            if (_breached[id][p]) continue;
            token.safeTransfer(p, c.stakePerParty);
        }

        emit Dissolved(id);
    }

    /// @notice Anyone-callable refund after deadline if state is still PROPOSED.
    ///         Returns each signed participant's stake.
    function expire(uint256 id) external nonReentrant {
        CoalitionData storage c = _coalitions[id];
        if (c.state != State.PROPOSED) revert CoalitionNotProposed();
        if (block.timestamp <= c.deadline) revert DeadlineNotReached();

        c.state = State.EXPIRED;
        IERC20 token = IERC20(c.stakeToken);
        uint256 participantsLen = c.participants.length;
        for (uint256 i = 0; i < participantsLen; i++) {
            address p = c.participants[i];
            if (_signed[id][p]) {
                token.safeTransfer(p, c.stakePerParty);
            }
        }

        emit Expired(id);
    }

    // ---------- Views ----------

    /// @notice Returns full coalition state. Used by the workflow plugin's
    ///         `check-status` and `sign`/`activate`/etc. pre-checks.
    function getCoalition(uint256 id)
        external
        view
        returns (
            bytes32 termsHash,
            address[] memory participants,
            address stakeToken,
            uint256 stakePerParty,
            uint256 deadline,
            uint8 signedCount,
            uint8 breachedCount,
            uint8 slashedCount,
            State state
        )
    {
        CoalitionData storage c = _coalitions[id];
        return (
            c.termsHash,
            c.participants,
            c.stakeToken,
            c.stakePerParty,
            c.deadline,
            c.signedCount,
            c.breachedCount,
            c.slashedCount,
            c.state
        );
    }

    function isSigned(uint256 id, address party) external view returns (bool) {
        return _signed[id][party];
    }

    function isBreached(uint256 id, address party) external view returns (bool) {
        return _breached[id][party];
    }

    function isSlashed(uint256 id, address party) external view returns (bool) {
        return _slashed[id][party];
    }
}
