import express from "express";

import cors from "cors";

import crypto from "crypto";

const app = express();

app.use(cors());

app.use(express.json());

const rooms = {};

let waitingRandomTicketId = null;

const randomTickets = {};

const PLAYER_DISCONNECT_AFTER_MS = 15 * 1e3;

const ROOM_IDLE_TTL_MS = 30 * 60 * 1e3;

const ROOM_ABSOLUTE_TTL_MS = 6 * 60 * 60 * 1e3;

const FINAL_RESULT_GRACE_MS = 24 * 60 * 60 * 1e3;

const ROOM_CLEANUP_INTERVAL_MS = 60 * 1e3;

const RANDOM_TICKET_TTL_MS = 1e3 * 60 * 3;

const RANDOM_REWARD_LIMIT_PER_ROOM = 3;

const BINARY_SHIFT_SERVER_KEY = process.env.BINARY_SHIFT_SERVER_KEY || "";

const CPU_WIN_POINT = 2;
const CPU_DRAW_POINT = 1;
const CPU_LOSE_POINT = 0;

if (!BINARY_SHIFT_SERVER_KEY) {
    console.error("[Startup] BINARY_SHIFT_SERVER_KEY is not configured");
    process.exit(1);
}

function getJstDateKey(timestamp = Date.now()) {
    const date = new Date(
        Number(timestamp) + 9 * 60 * 60 * 1000
    );

    return date.toISOString().slice(0, 10);
}

function safeCompareSecret(providedValue, expectedValue) {
    if (typeof providedValue !== "string" || typeof expectedValue !== "string") {
        return false;
    }
    const providedBuffer = Buffer.from(providedValue, "utf8");
    const expectedBuffer = Buffer.from(expectedValue, "utf8");
    if (providedBuffer.length !== expectedBuffer.length) {
        return false;
    }
    return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

function requireWixBackend(req, res, next) {
    const providedKey = req.get("x-binary-shift-key");
    if (!safeCompareSecret(providedKey, BINARY_SHIFT_SERVER_KEY)) {
        return res.status(403).json({
            error: "Forbidden",
            reason: "invalid_server_key"
        });
    }
    next();
}

function cleanupRandomTickets() {
    const now = Date.now();
    for (const ticketId of Object.keys(randomTickets)) {
        const ticket = randomTickets[ticketId];
        if (!ticket) {
            delete randomTickets[ticketId];
            continue;
        }
        if (!ticket.matched && now - ticket.createdAt > RANDOM_TICKET_TTL_MS) {
            delete randomTickets[ticketId];
            if (waitingRandomTicketId === ticketId) {
                waitingRandomTicketId = null;
            }
            continue;
        }
        if (ticket.matched && ticket.matchedAt && now - ticket.matchedAt > RANDOM_TICKET_TTL_MS) {
            delete randomTickets[ticketId];
            continue;
        }
    }
    if (waitingRandomTicketId && (!randomTickets[waitingRandomTicketId] || randomTickets[waitingRandomTicketId].matched)) {
        waitingRandomTicketId = null;
    }
}

function removeRoomAndRelatedTickets(roomId) {
    for (const ticketId of Object.keys(randomTickets)) {
        const ticket = randomTickets[ticketId];
        if (ticket?.roomId !== roomId) {
            continue;
        }
        delete randomTickets[ticketId];
        if (waitingRandomTicketId === ticketId) {
            waitingRandomTicketId = null;
        }
    }
    delete rooms[roomId];
}

function cleanupRooms() {
    const now = Date.now();
    for (const roomId of Object.keys(rooms)) {
        const room = rooms[roomId];
        if (!room) {
            delete rooms[roomId];
            continue;
        }
        ensureRoomLifecycle(room);
        if (room.phase === "final_result") {
            if (!Number.isFinite(room.finalResultAt)) {
                room.finalResultAt = now;
            }
            const finalResultExpired = now - room.finalResultAt > FINAL_RESULT_GRACE_MS;
            if (finalResultExpired) {
                removeRoomAndRelatedTickets(roomId);
            }
            continue;
        }
        const bothPlayersLeft = room.leaveState?.attack === true && room.leaveState?.defense === true;
        if (bothPlayersLeft) {
            if (!Number.isFinite(room.closedAt)) {
                room.closedAt = now;
            }
            removeRoomAndRelatedTickets(roomId);
            continue;
        }
        const absoluteExpired = Number.isFinite(room.createdAt) && now - room.createdAt > ROOM_ABSOLUTE_TTL_MS;
        if (absoluteExpired) {
            removeRoomAndRelatedTickets(roomId);
            continue;
        }
        const attackConnected = isParticipantConnected(room, "attack", now);
        const defenseConnected = isParticipantConnected(room, "defense", now);
        if (attackConnected || defenseConnected) {
            continue;
        }
        const latestTimestamp = getLatestRoomTimestamp(room);
        const idleExpired = Number.isFinite(latestTimestamp) && now - latestTimestamp > ROOM_IDLE_TTL_MS;
        if (idleExpired) {
            removeRoomAndRelatedTickets(roomId);
        }
    }
}

function generateRoomId() {
    return Math.random().toString(36).substring(2, 8);
}

function generateTicketId() {
    return Math.random().toString(36).substring(2, 10);
}

function generatePlayerId() {
    return Math.random().toString(36).substring(2, 12) + Date.now().toString(36);
}

function normalizeCpuFirstRole(value) {
    const role = typeof value === "string" ? value.trim() : "";
    return [ "attack", "defense", "random" ].includes(role) ? role : null;
}

function resolveCpuParticipants(firstRole) {
    const humanParticipant = firstRole === "random"
        ? (Math.random() < .5 ? "attack" : "defense")
        : firstRole;

    return {
        humanParticipant,
        cpuParticipant: humanParticipant === "attack" ? "defense" : "attack"
    };
}

function normalizeMemberInfo(body = {}) {
    const rawMemberId = typeof body.memberId === "string" ? body.memberId.trim() : "";
    const memberId = rawMemberId.length > 0 && rawMemberId.length <= 128 ? rawMemberId : null;
    return {
        memberId: memberId
    };
}

function createPublicParticipants(room, viewerPlayerId) {
    const attackIsYou =
        room.participants.attack.playerId === viewerPlayerId;

    const defenseIsYou =
        room.participants.defense.playerId === viewerPlayerId;

    return {
        attack: {
            playerId: attackIsYou
                ? room.participants.attack.playerId
                : null,
            isYou: attackIsYou,
            joined: !!room.participants.attack.playerId,
            isComputer:
                room.type === "cpu" &&
                room.cpu?.participant === "attack"
        },
        defense: {
            playerId: defenseIsYou
                ? room.participants.defense.playerId
                : null,
            isYou: defenseIsYou,
            joined: !!room.participants.defense.playerId,
            isComputer:
                room.type === "cpu" &&
                room.cpu?.participant === "defense"
        }
    };
}

function findWaitingTicketByClientId(clientId) {
    if (!clientId) return null;
    for (const ticketId of Object.keys(randomTickets)) {
        const ticket = randomTickets[ticketId];
        if (ticket && !ticket.matched && ticket.clientId === clientId) {
            return ticketId;
        }
    }
    return null;
}

function findWaitingTicketByMemberId(memberId) {
    if (!memberId) {
        return null;
    }
    for (const ticketId of Object.keys(randomTickets)) {
        const ticket = randomTickets[ticketId];
        if (ticket && !ticket.matched && ticket.memberId === memberId) {
            return ticketId;
        }
    }
    return null;
}

function isRandomTicketOwner(ticket, clientId) {
    if (!ticket) {
        return false;
    }
    if (typeof clientId !== "string" || !clientId.trim()) {
        return false;
    }
    return ticket.clientId === clientId.trim();
}

function createInitialRoom(type = "manual") {
    const now = Date.now();
    const room = {
        type: type,
        cpu: null,
        phase: "placement",
        round: 1,
        createdAt: now,
        lastActivityAt: now,
        finalResultAt: null,
        closedAt: null,
        connectionState: {
            attack: {
                lastSeenAt: null
            },
            defense: {
                lastSeenAt: null
            }
        },
        leaveState: {
            attack: false,
            defense: false
        },
        players: {
            attack: {
                hand: [],
                placedCards: []
            },
            defense: {
                hand: [],
                placedCards: []
            }
        },
        roles: {
            attack: "attack",
            defense: "defense"
        },
        participants: {
            attack: {
                playerId: null,
                memberId: null
            },
            defense: {
                playerId: null,
                memberId: null
            }
        },
        totalScore: {
            attack: 0,
            defense: 0
        },
        finalBinary: {
            attack: null,
            defense: null
        },
        rewardMatchCount: 0,
        rewardAppliedThisMatch: false,
        rewardResult: null,
        matchNumber: 1,
        battleState: null,
        openInfo: null,
        openReady: null,
        lastReplaceIndex: null,
        nextRoundReady: null,
        rematchState: {
            attack: null,
            defense: null
        }
    };
    ensureRoomLifecycle(room);
    return room;
}

function getRolePlayer(room, role) {
    return room.players[role];
}

function getCpuRole(room) {
    const participant = room.cpu?.participant;

    if (participant !== "attack" && participant !== "defense") {
        return null;
    }

    if (room.roles.attack === participant) {
        return "attack";
    }

    if (room.roles.defense === participant) {
        return "defense";
    }

    return null;
}

function getCpuHumanParticipant(room) {
    const cpuParticipant =
        room?.cpu?.participant;

    if (cpuParticipant === "attack") {
        return "defense";
    }

    if (cpuParticipant === "defense") {
        return "attack";
    }

    return null;
}

function prepareCpuRematchRoles(room) {
    if (!room || room.type !== "cpu") {
        return null;
    }

    const cpuParticipant =
        room.cpu?.participant;

    const humanParticipant =
        room.cpu?.humanParticipant ||
        getCpuHumanParticipant(room);

    if (
        !humanParticipant ||
        !cpuParticipant ||
        humanParticipant === cpuParticipant
    ) {
        return null;
    }

    const setting =
        room.cpu?.firstRoleSetting;

    let humanFirstRole;

    if (setting === "random") {
        humanFirstRole =
            Math.random() < .5
                ? "attack"
                : "defense";
    } else if (
        setting === "attack" ||
        setting === "defense"
    ) {
        humanFirstRole = setting;
    } else {
        humanFirstRole =
            room.cpu?.currentHumanFirstRole ||
            "attack";
    }

    if (humanFirstRole === "attack") {
        room.roles = {
            attack: humanParticipant,
            defense: cpuParticipant
        };
    } else {
        room.roles = {
            attack: cpuParticipant,
            defense: humanParticipant
        };
    }

    room.cpu.humanParticipant =
        humanParticipant;

    room.cpu.currentHumanFirstRole =
        humanFirstRole;

    return humanFirstRole;
}

function createCpuPlacementCards() {
    const cards = [ 0, 0, 0, 1, 1, 1 ];

    for (let i = cards.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ cards[i], cards[j] ] = [ cards[j], cards[i] ];
    }

    return cards.slice(0, 3);
}

function applyPlacementCard(room, role, card) {
    if (!room) {
        return {
            ok: false,
            status: 404,
            error: "Room not found",
            reason: "room_not_found"
        };
    }

    if (room.phase !== "placement") {
        return {
            ok: false,
            status: 400,
            error: "Not placement phase",
            reason: "invalid_phase"
        };
    }

    if (role !== "attack" && role !== "defense") {
        return {
            ok: false,
            status: 400,
            error: "Invalid role",
            reason: "invalid_role"
        };
    }

    if (card !== 0 && card !== 1) {
        return {
            ok: false,
            status: 400,
            error: "Invalid card",
            reason: "invalid_card"
        };
    }

    const player = getRolePlayer(room, role);

    if (!player) {
        return {
            ok: false,
            status: 400,
            error: "Player not found",
            reason: "player_data_not_found"
        };
    }

    if (player.placedCards.length >= 3) {
        return {
            ok: false,
            status: 400,
            error: "Already placed",
            reason: "already_placed"
        };
    }

    player.placedCards.push(card);

    const attackPlayer = getRolePlayer(room, "attack");
    const defensePlayer = getRolePlayer(room, "defense");
    const attackCount = attackPlayer.placedCards.length;
    const defenseCount = defensePlayer.placedCards.length;

    if (attackCount === 3 && defenseCount === 3) {
        room.phase = "open";
        room.openInfo = createEmptyOpenInfo();
        room.battleState = null;
    }

    touchRoomActivity(room);

    return {
        ok: true,
        role,
        phase: room.phase,
        attackCount,
        defenseCount
    };
}

function runCpuPlacement(room) {
    if (
        !room ||
        room.type !== "cpu" ||
        room.phase !== "placement"
    ) {
        return false;
    }

    const cpuRole = getCpuRole(room);

    if (!cpuRole) {
        return false;
    }

    const cpuPlayer = getRolePlayer(room, cpuRole);

    if (!cpuPlayer || cpuPlayer.placedCards.length >= 3) {
        return false;
    }

    const neededCount = 3 - cpuPlayer.placedCards.length;
    const selectedCards = createCpuPlacementCards();

    for (let i = 0; i < neededCount; i++) {
        const result = applyPlacementCard(
            room,
            cpuRole,
            selectedCards[i]
        );

        if (!result.ok) {
            console.error(
                "[CPU Placement] Failed:",
                result.reason
            );

            return false;
        }
    }

    return true;
}

function createCpuOpenIndexes() {
    const indexes = [ 0, 1, 2 ];

    for (let i = indexes.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ indexes[i], indexes[j] ] = [ indexes[j], indexes[i] ];
    }

    const openCount = Math.floor(Math.random() * 4);
    return indexes.slice(0, openCount);
}

function applyOpenSelection(room, role, selectedIndexes) {
    if (!room) {
        return {
            ok: false,
            status: 404,
            error: "Room not found",
            reason: "room_not_found"
        };
    }

    if (room.phase !== "open") {
        return {
            ok: false,
            status: 400,
            error: "Not open phase",
            reason: "invalid_phase"
        };
    }

    if (role !== "defense") {
        return {
            ok: false,
            status: 403,
            error: "Only defense can open",
            reason: "defense_only"
        };
    }

    if (room.openInfo?.completed) {
        return {
            ok: false,
            status: 400,
            error: "Open already completed",
            reason: "open_already_completed"
        };
    }

    if (!Array.isArray(selectedIndexes)) {
        return {
            ok: false,
            status: 400,
            error: "Invalid selected indexes",
            reason: "invalid_selected_indexes"
        };
    }

    if (selectedIndexes.length > 3) {
        return {
            ok: false,
            status: 400,
            error: "Too many selected cards",
            reason: "too_many_selected_cards"
        };
    }

    const defensePlayer = getRolePlayer(room, "defense");
    const attackPlayer = getRolePlayer(room, "attack");
    const defenseCards = defensePlayer?.placedCards ?? [];
    const attackCards = attackPlayer?.placedCards ?? [];

    if (defenseCards.length !== 3 || attackCards.length !== 3) {
        return {
            ok: false,
            status: 400,
            error: "Build not completed",
            reason: "build_not_completed"
        };
    }

    const indexSet = new Set();

    for (const rawIndex of selectedIndexes) {
        const index = Number(rawIndex);

        if (!Number.isInteger(index)) {
            return {
                ok: false,
                status: 400,
                error: "Invalid selected index",
                reason: "invalid_selected_index"
            };
        }

        if (index < 0 || index > 2) {
            return {
                ok: false,
                status: 400,
                error: "Selected index out of range",
                reason: "selected_index_out_of_range"
            };
        }

        if (indexSet.has(index)) {
            return {
                ok: false,
                status: 400,
                error: "Duplicate selected index",
                reason: "duplicate_selected_index"
            };
        }

        indexSet.add(index);
    }

    const selectedCards =
        [ ...indexSet ].map(index => defenseCards[index]);

    const defenseOpen = countCards(selectedCards);
    const scoutCount = Math.max(0, defenseOpen.total - 1);
    const attackScouted = makeScoutCounts(attackCards, scoutCount);

    room.openInfo = {
        completed: true,
        defenseOpen,
        attackScouted
    };

    room.openReady = {
        attack: false,
        defense: false
    };

    room.battleState = null;
    touchRoomActivity(room);

    return {
        ok: true,
        role,
        phase: room.phase,
        openInfo: room.openInfo,
        openReady: room.openReady
    };
}

function applyOpenReady(room, role) {
    if (!room) {
        return {
            ok: false,
            status: 404,
            error: "Room not found",
            reason: "room_not_found"
        };
    }

    if (room.phase !== "open") {
        return {
            ok: false,
            status: 400,
            error: "Not open phase",
            reason: "invalid_phase"
        };
    }

    if (role !== "attack" && role !== "defense") {
        return {
            ok: false,
            status: 400,
            error: "Invalid role",
            reason: "invalid_role"
        };
    }

    if (!room.openInfo?.completed) {
        return {
            ok: false,
            status: 400,
            error: "Open not completed",
            reason: "open_not_completed"
        };
    }

    if (!room.openReady) {
        room.openReady = {
            attack: false,
            defense: false
        };
    }

    room.openReady[role] = true;

    if (room.openReady.attack && room.openReady.defense) {
        room.phase = "battle";
        initializeBattleState(room);
    }

    touchRoomActivity(room);

    return {
        ok: true,
        waiting: room.phase === "open",
        role,
        phase: room.phase,
        openInfo: room.openInfo,
        openReady: room.openReady,
        battleState: room.battleState
    };
}

function runCpuOpen(room) {
    if (
        !room ||
        room.type !== "cpu" ||
        room.phase !== "open"
    ) {
        return false;
    }

    const cpuRole = getCpuRole(room);

    if (!cpuRole) {
        return false;
    }

    let changed = false;

    if (!room.openInfo?.completed) {
        if (cpuRole !== "defense") {
            return false;
        }

        const openResult = applyOpenSelection(
            room,
            "defense",
            createCpuOpenIndexes()
        );

        if (!openResult.ok) {
            console.error(
                "[CPU Open] Selection failed:",
                openResult.reason
            );

            return false;
        }

        changed = true;
    }

    if (
        room.phase === "open" &&
        room.openInfo?.completed &&
        room.openReady?.[cpuRole] !== true
    ) {
        const readyResult =
            applyOpenReady(room, cpuRole);

        if (!readyResult.ok) {
            console.error(
                "[CPU Open] Ready failed:",
                readyResult.reason
            );

            return changed;
        }

        changed = true;
    }

    return changed;
}

function battleFailure(status, error, reason) {
    return {
        ok: false,
        status,
        error,
        reason
    };
}

function applyBattleAction(room, role, action = {}) {
    if (!room) {
        return battleFailure(
            404,
            "Room not found",
            "room_not_found"
        );
    }

    if (room.phase !== "battle") {
        return battleFailure(
            400,
            "Not battle phase",
            "invalid_phase"
        );
    }

    const bs = room.battleState;

    if (!bs) {
        return battleFailure(
            400,
            "Battle state not found",
            "battle_state_not_found"
        );
    }

    if (role !== bs.currentRole) {
        return battleFailure(
            403,
            "Not your turn",
            "not_your_turn"
        );
    }

    const cardIndex =
        typeof action.cardIndex === "number"
            ? action.cardIndex
            : Number.NaN;

    const position =
        typeof action.position === "number"
            ? action.position
            : Number.NaN;

    const face = action.face;

    if (!Number.isInteger(cardIndex)) {
        return battleFailure(
            400,
            "Invalid card index",
            "invalid_card_index"
        );
    }

    if (face !== "表" && face !== "裏") {
        return battleFailure(
            400,
            "Invalid face",
            "invalid_face"
        );
    }

    if (
        !Number.isInteger(position) ||
        position < 0 ||
        position > 5
    ) {
        return battleFailure(
            400,
            "Invalid position",
            "invalid_position"
        );
    }

    const reverseFace =
        value => value === "表" ? "裏" : "表";

    const place = (
        card,
        owner,
        faceValue,
        targetPosition,
        placedBy = role
    ) => {
        if (
            targetPosition < 0 ||
            targetPosition >= bs.pointArea.length
        ) {
            throw new Error("Invalid position");
        }

        if (bs.pointArea[targetPosition]) {
            throw new Error("Position filled");
        }

        bs.pointArea[targetPosition] = {
            card,
            owner,
            face: faceValue,
            placedBy
        };
    };

    const success = () => {
        touchRoomActivity(room);

        return {
            ok: true,
            phase: room.phase,
            battleState: bs
        };
    };

    try {
        if (bs.step === 1) {
            if (role !== "attack") {
                throw new Error("Not your turn");
            }

            if (position !== 0) {
                throw new Error("Must left");
            }

            const card = bs.attackHand[cardIndex];

            if (!card) {
                throw new Error("Invalid card");
            }

            place(
                card.value,
                "attack",
                face,
                0
            );

            bs.attackHand.splice(cardIndex, 1);
            bs.forcedFace = reverseFace(face);
            bs.currentRole = "defense";
            bs.step = 2;

            return success();
        }

        if (bs.step === 2) {
            if (role !== "defense") {
                throw new Error("Not your turn");
            }

            if (face !== bs.forcedFace) {
                throw new Error("Forced");
            }

            const card = bs.attackHand[cardIndex];

            if (!card) {
                throw new Error("Invalid card");
            }

            place(
                card.value,
                "attack",
                face,
                position
            );

            bs.attackHand.splice(cardIndex, 1);
            bs.forcedFace = null;
            bs.currentRole = "defense";
            bs.step = 3;

            return success();
        }

        if (bs.step === 3) {
            if (role !== "defense") {
                throw new Error("Not your turn");
            }

            const card = bs.defenseHand[cardIndex];

            if (!card) {
                throw new Error("Invalid card");
            }

            place(
                card.value,
                "defense",
                face,
                position
            );

            bs.defenseHand.splice(cardIndex, 1);
            bs.forcedFace = reverseFace(face);
            bs.currentRole = "attack";
            bs.step = 4;

            return success();
        }

        if (bs.step === 4) {
            if (role !== "attack") {
                throw new Error("Not your turn");
            }

            if (face !== bs.forcedFace) {
                throw new Error("Forced");
            }

            const card = bs.defenseHand[cardIndex];

            if (!card) {
                throw new Error("Invalid card");
            }

            place(
                card.value,
                "defense",
                face,
                position
            );

            bs.defenseHand.splice(cardIndex, 1);
            bs.forcedFace = null;
            bs.currentRole = "attack";
            bs.step = 5;

            return success();
        }

        if (bs.step === 5) {
            if (role !== "attack") {
                throw new Error("Not your turn");
            }

            const combined = [
                ...bs.attackHand,
                ...bs.defenseHand
            ];

            const card = combined[cardIndex];

            if (!card) {
                throw new Error("Invalid card");
            }

            place(
                card.value,
                card.owner,
                face,
                position
            );

            if (card.owner === "attack") {
                bs.attackHand =
                    bs.attackHand.filter(
                        item => item !== card
                    );
            } else {
                bs.defenseHand =
                    bs.defenseHand.filter(
                        item => item !== card
                    );
            }

            const lastCard =
                bs.attackHand[0] ||
                bs.defenseHand[0];

            if (!lastCard) {
                throw new Error("No card");
            }

            const lastPosition =
                bs.pointArea.findIndex(
                    point => !point
                );

            if (lastPosition === -1) {
                throw new Error("No empty position");
            }

            place(
                lastCard.value,
                lastCard.owner,
                "表",
                lastPosition,
                "defense"
            );

            bs.attackHand = [];
            bs.defenseHand = [];
            bs.currentRole = "attack";
            bs.forcedFace = null;
            room.phase = "replace_attack";

            return success();
        }

        return battleFailure(
            400,
            "Invalid battle step",
            "invalid_battle_step"
        );
    } catch (error) {
        const reasons = {
            "Not your turn": "not_your_turn",
            "Invalid card": "invalid_card",
            "Position filled": "position_filled",
            "Invalid position": "invalid_position",
            Forced: "invalid_forced_face",
            "Must left": "step1_left_only",
            "No card": "remaining_card_not_found",
            "No empty position":
                "empty_position_not_found"
        };

        return battleFailure(
            400,
            error.message,
            reasons[error.message] ||
                "battle_operation_failed"
        );
    }
}

function getRandomIndex(length) {
    if (!Number.isInteger(length) || length <= 0) {
        return null;
    }

    return Math.floor(Math.random() * length);
}

function getRandomBattleFace() {
    return Math.random() < .5 ? "表" : "裏";
}

function getEmptyBattlePositions(battleState) {
    if (!Array.isArray(battleState?.pointArea)) {
        return [];
    }

    return battleState.pointArea
        .map((point, index) => point ? null : index)
        .filter(index => index !== null);
}

function createCpuBattleAction(room) {
    if (
        !room ||
        room.type !== "cpu" ||
        room.phase !== "battle"
    ) {
        return null;
    }

    const bs = room.battleState;
    const cpuRole = getCpuRole(room);

    if (
        !bs ||
        !cpuRole ||
        bs.currentRole !== cpuRole
    ) {
        return null;
    }

    const emptyPositions =
        getEmptyBattlePositions(bs);

    if (bs.step === 1) {
        const cardIndex =
            getRandomIndex(bs.attackHand.length);

        if (cardIndex === null) return null;

        return {
            cardIndex,
            face: getRandomBattleFace(),
            position: 0
        };
    }

    if (bs.step === 2) {
        const cardIndex =
            getRandomIndex(bs.attackHand.length);

        const positionIndex =
            getRandomIndex(emptyPositions.length);

        if (
            cardIndex === null ||
            positionIndex === null ||
            !bs.forcedFace
        ) {
            return null;
        }

        return {
            cardIndex,
            face: bs.forcedFace,
            position: emptyPositions[positionIndex]
        };
    }

    if (bs.step === 3) {
        const cardIndex =
            getRandomIndex(bs.defenseHand.length);

        const positionIndex =
            getRandomIndex(emptyPositions.length);

        if (
            cardIndex === null ||
            positionIndex === null
        ) {
            return null;
        }

        return {
            cardIndex,
            face: getRandomBattleFace(),
            position: emptyPositions[positionIndex]
        };
    }

    if (bs.step === 4) {
        const cardIndex =
            getRandomIndex(bs.defenseHand.length);

        const positionIndex =
            getRandomIndex(emptyPositions.length);

        if (
            cardIndex === null ||
            positionIndex === null ||
            !bs.forcedFace
        ) {
            return null;
        }

        return {
            cardIndex,
            face: bs.forcedFace,
            position: emptyPositions[positionIndex]
        };
    }

    if (bs.step === 5) {
        const combinedLength =
            bs.attackHand.length +
            bs.defenseHand.length;

        const cardIndex =
            getRandomIndex(combinedLength);

        const positionIndex =
            getRandomIndex(emptyPositions.length);

        if (
            cardIndex === null ||
            positionIndex === null
        ) {
            return null;
        }

        return {
            cardIndex,
            face: getRandomBattleFace(),
            position: emptyPositions[positionIndex]
        };
    }

    return null;
}

function runCpuBattle(room) {
    if (
        !room ||
        room.type !== "cpu" ||
        room.phase !== "battle"
    ) {
        return false;
    }

    let changed = false;

    for (let guard = 0; guard < 6; guard++) {
        const bs = room.battleState;
        const cpuRole = getCpuRole(room);

        if (
            room.phase !== "battle" ||
            !bs ||
            !cpuRole ||
            bs.currentRole !== cpuRole
        ) {
            break;
        }

        const action =
            createCpuBattleAction(room);

        if (!action) {
            console.error(
                "[CPU Battle] Legal action not found",
                {
                    step: bs.step,
                    role: cpuRole
                }
            );

            break;
        }

        const result = applyBattleAction(
            room,
            cpuRole,
            action
        );

        if (!result.ok) {
            console.error(
                "[CPU Battle] Action failed:",
                result.reason
            );

            break;
        }

        changed = true;
    }

    return changed;
}

function replaceFailure(status, error, reason) {
    return {
        ok: false,
        status,
        error,
        reason
    };
}

function hasOwnPlacedCard(battleState, startIndex, role) {
    for (let i = 0; i < 3; i++) {
        if (
            battleState.pointArea[startIndex + i]?.placedBy ===
            role
        ) {
            return true;
        }
    }

    return false;
}

function getReplacePattern(battleState, startIndex) {
    return battleState.pointArea
        .slice(startIndex, startIndex + 3)
        .map(point => String(point?.card ?? ""))
        .join("");
}

function getLegalReplaceIndexes(room, role) {
    const bs = room?.battleState;

    if (
        !bs ||
        !Array.isArray(bs.pointArea) ||
        bs.pointArea.length !== 6
    ) {
        return [];
    }

    const expectedPattern =
        role === "attack" ? "000" : "111";

    return [ 0, 1, 2, 3 ].filter(index => {
        if (
            role === "defense" &&
            index === room.lastReplaceIndex
        ) {
            return false;
        }

        return (
            getReplacePattern(bs, index) ===
                expectedPattern &&
            hasOwnPlacedCard(bs, index, role)
        );
    });
}

function applyReplaceAction(room, role, rawIndex) {
    if (!room) {
        return replaceFailure(
            404,
            "Room not found",
            "room_not_found"
        );
    }

    if (
        room.phase !== "replace_attack" &&
        room.phase !== "replace_defense"
    ) {
        return replaceFailure(
            400,
            "Invalid phase",
            "invalid_phase"
        );
    }

    const bs = room.battleState;

    if (
        !bs ||
        !Array.isArray(bs.pointArea) ||
        bs.pointArea.length !== 6
    ) {
        return replaceFailure(
            400,
            "Battle state not found",
            "battle_state_not_found"
        );
    }

    const expectedRole =
        room.phase === "replace_attack"
            ? "attack"
            : "defense";

    if (role !== expectedRole) {
        return replaceFailure(
            403,
            "Not your turn",
            "not_your_turn"
        );
    }

    const index = Number(rawIndex);

    if (index === -1) {
        if (role === "attack") {
            room.phase = "replace_defense";
            room.lastReplaceIndex = null;
            bs.currentRole = "defense";
            touchRoomActivity(room);
        } else {
            bs.currentRole = null;
            room.lastReplaceIndex = null;
            finalizeRound(room);
        }

        return {
            ok: true,
            phase: room.phase,
            battleState: bs,
            lastReplaceIndex:
                room.lastReplaceIndex ?? null
        };
    }

    if (
        !Number.isInteger(index) ||
        index < 0 ||
        index > 3
    ) {
        return replaceFailure(
            400,
            "Invalid index",
            "invalid_index"
        );
    }

    if (
        role === "defense" &&
        index === room.lastReplaceIndex
    ) {
        return replaceFailure(
            400,
            "Same position not allowed",
            "same_position_not_allowed"
        );
    }

    const expectedPattern =
        role === "attack" ? "000" : "111";

    if (
        getReplacePattern(bs, index) !==
        expectedPattern
    ) {
        return replaceFailure(
            400,
            "Invalid pattern",
            "invalid_pattern"
        );
    }

    if (!hasOwnPlacedCard(bs, index, role)) {
        return replaceFailure(
            400,
            "No own placed card",
            "no_own_placed_card"
        );
    }

    const replacement =
        role === "attack" ? "1" : "0";

    for (let i = 0; i < 3; i++) {
        bs.pointArea[index + i].card =
            replacement;
    }

    if (role === "attack") {
        room.lastReplaceIndex = index;
        room.phase = "replace_defense";
        bs.currentRole = "defense";
        touchRoomActivity(room);
    } else {
        room.lastReplaceIndex = null;
        bs.currentRole = null;
        finalizeRound(room);
    }

    return {
        ok: true,
        phase: room.phase,
        battleState: bs,
        lastReplaceIndex:
            room.lastReplaceIndex ?? null
    };
}

function createCpuReplaceIndex(room) {
    if (
        !room ||
        room.type !== "cpu" ||
        (
            room.phase !== "replace_attack" &&
            room.phase !== "replace_defense"
        )
    ) {
        return null;
    }

    const cpuRole = getCpuRole(room);

    const expectedRole =
        room.phase === "replace_attack"
            ? "attack"
            : "defense";

    if (!cpuRole || cpuRole !== expectedRole) {
        return null;
    }

    const indexes =
        getLegalReplaceIndexes(room, cpuRole);

    if (indexes.length === 0) {
        return -1;
    }

    /*
      暫定CPU：
      候補があっても20％でSkipする。
    */
    if (Math.random() < .2) {
        return -1;
    }

    const randomIndex =
        getRandomIndex(indexes.length);

    return randomIndex === null
        ? -1
        : indexes[randomIndex];
}

function runCpuReplace(room) {
    if (
        !room ||
        room.type !== "cpu" ||
        (
            room.phase !== "replace_attack" &&
            room.phase !== "replace_defense"
        )
    ) {
        return false;
    }

    const cpuRole = getCpuRole(room);

    const expectedRole =
        room.phase === "replace_attack"
            ? "attack"
            : "defense";

    if (!cpuRole || cpuRole !== expectedRole) {
        return false;
    }

    const index =
        createCpuReplaceIndex(room);

    if (index === null) {
        console.error(
            "[CPU Replace] Legal action not found",
            {
                phase: room.phase,
                role: cpuRole
            }
        );

        return false;
    }

    const result =
        applyReplaceAction(
            room,
            cpuRole,
            index
        );

    if (!result.ok) {
        console.error(
            "[CPU Replace] Action failed:",
            result.reason
        );

        return false;
    }

    return true;
}

function nextRoundFailure(status, error, reason) {
    return {
        ok: false,
        status,
        error,
        reason
    };
}

function applyNextRoundReady(room, role) {
    if (!room) {
        return nextRoundFailure(
            404,
            "Room not found",
            "room_not_found"
        );
    }

    if (room.phase !== "round_result") {
        return nextRoundFailure(
            400,
            "Not round result phase",
            "invalid_phase"
        );
    }

    if (role !== "attack" && role !== "defense") {
        return nextRoundFailure(
            400,
            "Invalid role",
            "invalid_role"
        );
    }

    if (!room.nextRoundReady) {
        room.nextRoundReady = {
            attack: false,
            defense: false
        };
    }

    room.nextRoundReady[role] = true;

    if (
        !room.nextRoundReady.attack ||
        !room.nextRoundReady.defense
    ) {
        touchRoomActivity(room);

        return {
            ok: true,
            waiting: true,
            role,
            phase: room.phase,
            round: room.round,
            roles: room.roles,
            nextRoundReady: room.nextRoundReady
        };
    }

    room.round = 2;
    swapRoles(room);
    resetRoomForBuild(room);
    touchRoomActivity(room);

    return {
        ok: true,
        waiting: false,
        role,
        phase: room.phase,
        round: room.round,
        roles: room.roles,
        nextRoundReady: room.nextRoundReady
    };
}

function runCpuRoundResult(room) {
    if (
        !room ||
        room.type !== "cpu" ||
        room.phase !== "round_result"
    ) {
        return false;
    }

    const cpuRole = getCpuRole(room);

    if (!cpuRole) {
        return false;
    }

    if (room.nextRoundReady?.[cpuRole] === true) {
        return false;
    }

    const result = applyNextRoundReady(
        room,
        cpuRole
    );

    if (!result.ok) {
        console.error(
            "[CPU Round Result] Ready failed:",
            result.reason
        );

        return false;
    }

    return true;
}

function swapRoles(room) {
    const tmp = room.roles.attack;
    room.roles.attack = room.roles.defense;
    room.roles.defense = tmp;
}

function resetRoomForBuild(room) {
    room.players.attack.hand = [];
    room.players.attack.placedCards = [];
    room.players.defense.hand = [];
    room.players.defense.placedCards = [];
    room.battleState = null;
    room.openInfo = null;
    room.openReady = null;
    room.lastReplaceIndex = null;
    room.nextRoundReady = null;
    room.phase = "placement";

    runCpuPlacement(room);
}

function resetRoomForRematch(room) {
    ensureRoomLifecycle(room);
    room.matchNumber = (room.matchNumber ?? 1) + 1;
    room.round = 1;
    room.totalScore = {
        attack: 0,
        defense: 0
    };
    room.finalBinary = {
        attack: null,
        defense: null
    };
    room.rewardAppliedThisMatch = false;
    room.rewardResult = null;
    room.finalResultAt = null;
    room.closedAt = null;
    resetRoomForBuild(room);
    room.rematchState = {
        attack: null,
        defense: null
    };
    room.leaveState = {
        attack: false,
        defense: false
    };
    touchRoomActivity(room);
}

function createEmptyOpenInfo() {
    return {
        completed: false,
        defenseOpen: {
            zeroCount: 0,
            oneCount: 0,
            total: 0
        },
        attackScouted: {
            zeroCount: 0,
            oneCount: 0,
            total: 0
        }
    };
}

function countCards(cards) {
    return {
        zeroCount: cards.filter(c => c === 0).length,
        oneCount: cards.filter(c => c === 1).length,
        total: cards.length
    };
}

function makeScoutCounts(cards, scoutCount) {
    const shuffled = [ ...cards ];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const temp = shuffled[i];
        shuffled[i] = shuffled[j];
        shuffled[j] = temp;
    }
    const picked = shuffled.slice(0, scoutCount);
    return {
        zeroCount: picked.filter(v => v === 0).length,
        oneCount: picked.filter(v => v === 1).length,
        total: picked.length
    };
}

function initializeBattleState(room) {
    const attackPlayer = getRolePlayer(room, "attack");
    const defensePlayer = getRolePlayer(room, "defense");
    attackPlayer.hand = [ ...attackPlayer.placedCards ];
    defensePlayer.hand = [ ...defensePlayer.placedCards ];
    room.battleState = {
        step: 1,
        currentRole: "attack",
        forcedFace: null,
        attackHand: attackPlayer.hand.map(card => ({
            value: card,
            owner: "attack"
        })),
        defenseHand: defensePlayer.hand.map(card => ({
            value: card,
            owner: "defense"
        })),
        pointArea: Array(6).fill(null)
    };
}

function calculateRandomMatchReward(attackScore, defenseScore) {
    const diff = Math.abs(attackScore - defenseScore);
    if (diff === 0) {
        return {
            winner: "draw",
            diff: diff,
            attackPoint: 1,
            defensePoint: 1
        };
    }
    const winner = attackScore > defenseScore ? "attack" : "defense";
    const winnerPoint = Math.floor(diff / 2) + 1;
    if (winner === "attack") {
        return {
            winner: winner,
            diff: diff,
            attackPoint: winnerPoint,
            defensePoint: 1
        };
    }
    return {
        winner: winner,
        diff: diff,
        attackPoint: 1,
        defensePoint: winnerPoint
    };
}

function calculateCpuMatchReward(room) {
    const humanParticipant =
        room.cpu?.humanParticipant ||
        getCpuHumanParticipant(room);

    if (
        humanParticipant !== "attack" &&
        humanParticipant !== "defense"
    ) {
        return null;
    }

    const attackScore = room.totalScore.attack;
    const defenseScore = room.totalScore.defense;

    let winner = "draw";

    if (attackScore > defenseScore) {
        winner = "attack";
    } else if (defenseScore > attackScore) {
        winner = "defense";
    }

    const result =
        winner === "draw"
            ? "draw"
            : winner === humanParticipant
                ? "win"
                : "lose";

    const point =
        result === "win"
            ? CPU_WIN_POINT
            : result === "draw"
                ? CPU_DRAW_POINT
                : CPU_LOSE_POINT;

    return {
        winner,
        result,
        point,
        humanParticipant,
        attackScore,
        defenseScore,
        diff: Math.abs(attackScore - defenseScore)
    };
}

function applyRandomMatchReward(room) {
    if (!room) {
        return null;
    }
    if (room.rewardAppliedThisMatch) {
        return room.rewardResult;
    }
    if (room.type === "cpu") {
        const reward = calculateCpuMatchReward(room);

        room.rewardAppliedThisMatch = true;

        if (!reward) {
            room.rewardResult = {
                applied: false,
                reason: "cpu_reward_failed"
            };

            return room.rewardResult;
        }

        room.rewardMatchCount++;

        room.rewardResult = {
            applied: true,
            mode: "cpu",
            winner: reward.winner,
            result: reward.result,
            humanParticipant:
                reward.humanParticipant,
            humanPoint: reward.point,
            attackScore: reward.attackScore,
            defenseScore: reward.defenseScore,
            diff: reward.diff,
            rewardMatchCount:
                room.rewardMatchCount
        };

        return room.rewardResult;
    }

    if (room.type !== "random") {
        room.rewardAppliedThisMatch = true;
        room.rewardResult = {
            applied: false,
            reason: "not_random_match"
        };
        return room.rewardResult;
    }
    if (room.rewardMatchCount >= RANDOM_REWARD_LIMIT_PER_ROOM) {
        room.rewardAppliedThisMatch = true;
        room.rewardResult = {
            applied: false,
            reason: "reward_limit_reached",
            rewardMatchCount: room.rewardMatchCount,
            rewardRemainingCount: 0
        };
        return room.rewardResult;
    }
    const attackParticipant = room.participants.attack;
    const defenseParticipant = room.participants.defense;
    if (!attackParticipant?.memberId || !defenseParticipant?.memberId) {
        room.rewardAppliedThisMatch = true;
        room.rewardResult = {
            applied: false,
            reason: "missing_member_id"
        };
        return room.rewardResult;
    }
    if (attackParticipant.memberId === defenseParticipant.memberId) {
        room.rewardAppliedThisMatch = true;
        room.rewardResult = {
            applied: false,
            reason: "same_member_id",
            rewardMatchCount: room.rewardMatchCount,
            rewardRemainingCount: Math.max(0, RANDOM_REWARD_LIMIT_PER_ROOM - room.rewardMatchCount)
        };
        return room.rewardResult;
    }
    const attackScore = room.totalScore.attack;
    const defenseScore = room.totalScore.defense;
    const reward = calculateRandomMatchReward(attackScore, defenseScore);
    room.rewardMatchCount++;
    room.rewardAppliedThisMatch = true;
    room.rewardResult = {
        applied: true,
        winner: reward.winner,
        diff: reward.diff,
        attackScore: attackScore,
        defenseScore: defenseScore,
        attackPoint: reward.attackPoint,
        defensePoint: reward.defensePoint,
        rewardMatchCount: room.rewardMatchCount,
        rewardRemainingCount: Math.max(0, RANDOM_REWARD_LIMIT_PER_ROOM - room.rewardMatchCount)
    };
    return room.rewardResult;
}


app.post("/api/create-room", requireWixBackend, (req, res) => {
    const roomId = generateRoomId();
    const room = createInitialRoom("manual");
    const playerId = generatePlayerId();
    const member = normalizeMemberInfo(req.body);
    if (!member.memberId) {
        return res.status(400).json({
            error: "memberId is required",
            reason: "missing_member_id"
        });
    }
    room.participants.attack.playerId = playerId;
    room.participants.attack.memberId = member.memberId;
    rooms[roomId] = room;
    return res.json({
        roomId: roomId,
        playerId: playerId
    });
});

app.post("/api/create-cpu-room", requireWixBackend, (req, res) => {
    cleanupRooms();

    const member = normalizeMemberInfo(req.body);
    const firstRole = normalizeCpuFirstRole(req.body?.firstRole);

    if (!member.memberId) {
        return res.status(400).json({
            error: "memberId is required",
            reason: "missing_member_id"
        });
    }

    if (!firstRole) {
        return res.status(400).json({
            error: "firstRole must be attack, defense or random",
            reason: "invalid_first_role"
        });
    }

    const {
        humanParticipant,
        cpuParticipant
    } = resolveCpuParticipants(firstRole);

    const roomId = generateRoomId();
    const humanPlayerId = generatePlayerId();
    const cpuPlayerId = "cpu_" + generatePlayerId();
    const room = createInitialRoom("cpu");

    room.participants[humanParticipant] = {
        playerId: humanPlayerId,
        memberId: member.memberId
    };

    room.participants[cpuParticipant] = {
        playerId: cpuPlayerId,
        memberId: null
    };

    room.cpu = {
        participant: cpuParticipant,
        humanParticipant,
        firstRoleSetting: firstRole,
        currentHumanFirstRole: humanParticipant,
        difficulty: "standard"
    };

    rooms[roomId] = room;
    runCpuPlacement(room);

    return res.json({
        success: true,
        roomId,
        playerId: humanPlayerId,
        participant: humanParticipant,
        role: humanParticipant,
        firstRole: humanParticipant,
        firstRoleSetting: firstRole,
        cpuParticipant,
        difficulty: room.cpu.difficulty,
        phase: room.phase
    });
});

app.post("/api/join-room/:roomId", requireWixBackend, (req, res) => {
    const roomId = req.params.roomId;
    const room = rooms[roomId];
    if (!room) {
        return res.status(404).json({
            error: "Room not found",
            reason: "room_not_found"
        });
    }
    ensureRoomLifecycle(room);
    if (!room.participants?.defense) {
        return res.status(500).json({
            error: "Room participant data is invalid",
            reason: "invalid_room_data"
        });
    }
    if (room.participants.defense.playerId !== null) {
        return res.status(409).json({
            error: "Room is full",
            reason: "room_full"
        });
    }
    const member = normalizeMemberInfo(req.body);
    if (!member.memberId) {
        return res.status(400).json({
            error: "memberId is required",
            reason: "missing_member_id"
        });
    }
    const playerId = generatePlayerId();
    room.participants.defense.playerId = playerId;
    room.participants.defense.memberId = member.memberId;
    if (!room.leaveState) {
        room.leaveState = {
            attack: false,
            defense: false
        };
    }
    room.leaveState.defense = false;
    if (room.connectionState?.defense) {
        room.connectionState.defense.lastSeenAt = null;
    }
    touchRoomActivity(room);
    return res.json({
        success: true,
        roomId: roomId,
        playerId: playerId,
        participant: "defense",
        phase: room.phase
    });
});

app.post("/api/leave-room/:roomId", (req, res) => {
    const roomId = req.params.roomId;
    const room = rooms[roomId];
    if (!room) {
        return res.json({
            success: true,
            alreadyRemoved: true,
            roomRemoved: true
        });
    }
    ensureRoomLifecycle(room);
    const auth = requireRoomPlayer(room, req.body);
    if (!auth.ok) {
        return res.status(auth.status).json(auth.response);
    }
    const participant = auth.access.participant;
    if (!room.leaveState) {
        room.leaveState = {
            attack: false,
            defense: false
        };
    }
    touchRoomActivity(room);
    if (room.connectionState?.[participant]) {
        room.connectionState[participant].lastSeenAt = null;
    }
    room.leaveState[participant] = true;

    if (room.type === "cpu") {
        removeRoomAndRelatedTickets(roomId);

        return res.json({
            success: true,
            alreadyRemoved: false,
            roomRemoved: true,
            retainedForReward: false,
            participant
        });
    }

    const bothPlayersLeft = room.leaveState.attack === true && room.leaveState.defense === true;
    if (!bothPlayersLeft) {
        return res.json({
            success: true,
            alreadyRemoved: false,
            roomRemoved: false,
            retainedForReward: room.phase === "final_result",
            participant: participant,
            phase: room.phase,
            leaveState: room.leaveState
        });
    }
    if (!Number.isFinite(room.closedAt)) {
        room.closedAt = Date.now();
    }
    if (room.phase === "final_result") {
        if (!Number.isFinite(room.finalResultAt)) {
            room.finalResultAt = Date.now();
        }
        return res.json({
            success: true,
            alreadyRemoved: false,
            roomRemoved: false,
            retainedForReward: true,
            participant: participant,
            phase: room.phase,
            leaveState: room.leaveState,
            closedAt: room.closedAt,
            finalResultAt: room.finalResultAt,
            rewardGraceUntil: room.finalResultAt + FINAL_RESULT_GRACE_MS
        });
    }
    removeRoomAndRelatedTickets(roomId);
    return res.json({
        success: true,
        alreadyRemoved: false,
        roomRemoved: true,
        retainedForReward: false,
        participant: participant
    });
});

app.post("/api/random-match", requireWixBackend, (req, res) => {
    cleanupRandomTickets();
    cleanupRooms();
    const clientId = typeof req.body?.clientId === "string" ? req.body.clientId.trim() : "";
    const member = normalizeMemberInfo(req.body);
    if (!clientId) {
        return res.status(400).json({
            error: "clientId is required"
        });
    }
    if (!member.memberId) {
        return res.status(401).json({
            error: "Login is required",
            reason: "missing_member_id"
        });
    }
    const existingWaitingTicketId = findWaitingTicketByClientId(clientId);
    if (existingWaitingTicketId) {
        const existingTicket = randomTickets[existingWaitingTicketId];
        if (existingTicket.memberId !== member.memberId) {
            return res.status(403).json({
                error: "Ticket owner mismatch",
                reason: "ticket_owner_mismatch"
            });
        }
        return res.json({
            matched: false,
            ticketId: existingWaitingTicketId
        });
    }
    const existingMemberTicketId = findWaitingTicketByMemberId(member.memberId);
    if (existingMemberTicketId) {
        return res.status(409).json({
            error: "This account is already waiting",
            reason: "same_member_already_waiting"
        });
    }
    if (waitingRandomTicketId && (!randomTickets[waitingRandomTicketId] || randomTickets[waitingRandomTicketId].matched)) {
        waitingRandomTicketId = null;
    }
    if (!waitingRandomTicketId) {
        const ticketId = generateTicketId();
        randomTickets[ticketId] = {
            clientId: clientId,
            matched: false,
            roomId: null,
            role: null,
            playerId: null,
            memberId: member.memberId,
            createdAt: Date.now()
        };
        waitingRandomTicketId = ticketId;
        return res.json({
            matched: false,
            ticketId: ticketId
        });
    }
    const firstTicketId = waitingRandomTicketId;
    const firstTicket = randomTickets[firstTicketId];
    if (!firstTicket || firstTicket.matched) {
        const ticketId = generateTicketId();
        randomTickets[ticketId] = {
            clientId: clientId,
            matched: false,
            roomId: null,
            role: null,
            playerId: null,
            memberId: member.memberId,
            createdAt: Date.now()
        };
        waitingRandomTicketId = ticketId;
        return res.json({
            matched: false,
            ticketId: ticketId
        });
    }
    if (firstTicket.clientId === clientId) {
        return res.json({
            matched: false,
            ticketId: firstTicketId
        });
    }
    if (firstTicket.memberId === member.memberId) {
        return res.status(409).json({
            matched: false,
            error: "You cannot match with the same account",
            reason: "same_member_id"
        });
    }
    const secondTicketId = generateTicketId();
    randomTickets[secondTicketId] = {
        clientId: clientId,
        matched: false,
        roomId: null,
        role: null,
        playerId: null,
        memberId: member.memberId,
        createdAt: Date.now()
    };
    const roomId = generateRoomId();
    const room = createInitialRoom("random");
    const attackPlayerId = generatePlayerId();
    const defensePlayerId = generatePlayerId();
    room.participants.attack.playerId = attackPlayerId;
    room.participants.attack.memberId = firstTicket.memberId;
    room.participants.defense.playerId = defensePlayerId;
    room.participants.defense.memberId = member.memberId;
    rooms[roomId] = room;
    randomTickets[firstTicketId] = {
        ...randomTickets[firstTicketId],
        matched: true,
        roomId: roomId,
        role: "attack",
        matchedAt: Date.now(),
        playerId: attackPlayerId
    };
    randomTickets[secondTicketId] = {
        ...randomTickets[secondTicketId],
        matched: true,
        roomId: roomId,
        role: "defense",
        matchedAt: Date.now(),
        playerId: defensePlayerId
    };
    waitingRandomTicketId = null;
    return res.json({
        matched: true,
        ticketId: secondTicketId,
        roomId: roomId,
        role: "defense",
        playerId: defensePlayerId
    });
});

app.get("/api/random-match/:ticketId", (req, res) => {
    cleanupRandomTickets();
    cleanupRooms();
    const ticketId = req.params.ticketId;
    const ticket = randomTickets[ticketId];
    if (!ticket) {
        return res.status(404).json({
            error: "Ticket not found",
            reason: "ticket_not_found"
        });
    }
    const clientId = typeof req.query?.clientId === "string" ? req.query.clientId.trim() : "";
    if (!clientId) {
        return res.status(400).json({
            error: "clientId is required",
            reason: "missing_client_id"
        });
    }
    if (!isRandomTicketOwner(ticket, clientId)) {
        return res.status(403).json({
            error: "Ticket owner mismatch",
            reason: "ticket_owner_mismatch"
        });
    }
    if (!ticket.matched) {
        return res.json({
            matched: false,
            ticketId: ticketId
        });
    }
    return res.json({
        matched: true,
        ticketId: ticketId,
        roomId: ticket.roomId,
        role: ticket.role,
        playerId: ticket.playerId
    });
});

app.post("/api/random-match-cancel", (req, res) => {
    cleanupRandomTickets();
    cleanupRooms();
    const ticketId = typeof req.body?.ticketId === "string" ? req.body.ticketId.trim() : "";
    const clientId = typeof req.body?.clientId === "string" ? req.body.clientId.trim() : "";
    if (!ticketId) {
        return res.status(400).json({
            error: "ticketId is required",
            reason: "missing_ticket_id"
        });
    }
    if (!clientId) {
        return res.status(400).json({
            error: "clientId is required",
            reason: "missing_client_id"
        });
    }
    const ticket = randomTickets[ticketId];
    if (!ticket) {
        return res.json({
            success: true,
            alreadyRemoved: true
        });
    }
    if (!isRandomTicketOwner(ticket, clientId)) {
        return res.status(403).json({
            error: "Ticket owner mismatch",
            reason: "ticket_owner_mismatch"
        });
    }
    if (ticket.matched) {
        return res.status(409).json({
            error: "Ticket already matched",
            reason: "ticket_already_matched"
        });
    }
    if (waitingRandomTicketId === ticketId) {
        waitingRandomTicketId = null;
    }
    delete randomTickets[ticketId];
    return res.json({
        success: true,
        alreadyRemoved: false
    });
});


app.get("/api/room-state/:roomId", (req, res) => {
    cleanupRooms();
    const roomId = req.params.roomId;
    const room = rooms[roomId];
    if (!room) {
        return res.status(404).json({
            error: "Room not found",
            reason: "room_not_found"
        });
    }
    ensureRoomLifecycle(room);
    const auth = requireRoomPlayer(room, req.query);
    if (!auth.ok) {
        return res.status(auth.status).json(auth.response);
    }
    const viewerPlayerId = auth.access.playerId;
    const viewerParticipant = auth.access.participant;
    touchParticipantPresence(room, viewerParticipant);
    runCpuPlacement(room);
    runCpuOpen(room);
    runCpuBattle(room);
    runCpuReplace(room);
    runCpuRoundResult(room);
    const publicParticipants = createPublicParticipants(room, viewerPlayerId);
    const connectionState = getRoomConnectionState(room);
    const attackPlayer = getRolePlayer(room, "attack");
    const defensePlayer = getRolePlayer(room, "defense");
    const placementInfo = {
        attackCount: attackPlayer.placedCards.length,
        defenseCount: defensePlayer.placedCards.length,
        attackCards: attackPlayer.placedCards,
        defenseCards: defensePlayer.placedCards
    };
    const matchEnd = {
        attack: room.rematchState?.attack ?? null,
        defense: room.rematchState?.defense ?? null
    };
    const rewardRemainingCount = Math.max(0, RANDOM_REWARD_LIMIT_PER_ROOM - room.rewardMatchCount);
    if (room.phase === "final_result") {
        const attackScore = room.totalScore.attack;
        const defenseScore = room.totalScore.defense;
        let winner = "draw";
        if (attackScore > defenseScore) {
            winner = "attack";
        }
        if (defenseScore > attackScore) {
            winner = "defense";
        }
        return res.json({
            type: room.type,
            cpu: room.cpu ?? null,
            phase: room.phase,
            roles: room.roles,
            finalResultAt: room.finalResultAt,
            rewardGraceUntil: Number.isFinite(room.finalResultAt) ? room.finalResultAt + FINAL_RESULT_GRACE_MS : null,
            closedAt: room.closedAt,
            viewerParticipant: viewerParticipant,
            participants: publicParticipants,
            connectionState: connectionState,
            result: {
                attackScore: attackScore,
                defenseScore: defenseScore,
                attackBinary: room.finalBinary.attack,
                defenseBinary: room.finalBinary.defense,
                winner: winner
            },
            round: room.round,
            totalScore: room.totalScore,
            finalBinary: room.finalBinary,
            rewardMatchCount: room.rewardMatchCount,
            rewardRemainingCount: rewardRemainingCount,
            rewardResult: room.rewardResult ?? null,
            matchNumber: room.matchNumber ?? 1,
            placementInfo: placementInfo,
            openInfo: room.openInfo ?? null,
            openReady: room.openReady ?? null,
            lastReplaceIndex: room.lastReplaceIndex ?? null,
            nextRoundReady: room.nextRoundReady ?? null,
            rematchState: room.rematchState,
            matchEnd: matchEnd
        });
    }
    return res.json({
        type: room.type,
        cpu: room.cpu ?? null,
        phase: room.phase,
        roles: room.roles,
        viewerParticipant: viewerParticipant,
        participants: publicParticipants,
        connectionState: connectionState,
        battleState: room.battleState,
        round: room.round,
        totalScore: room.totalScore,
        rewardMatchCount: room.rewardMatchCount,
        rewardRemainingCount: rewardRemainingCount,
        rewardResult: room.rewardResult ?? null,
        matchNumber: room.matchNumber ?? 1,
        placementInfo: placementInfo,
        openInfo: room.openInfo ?? null,
        openReady: room.openReady ?? null,
        lastReplaceIndex: room.lastReplaceIndex ?? null,
        nextRoundReady: room.nextRoundReady ?? null,
        rematchState: room.rematchState,
        matchEnd: matchEnd
    });
});

function getParticipantByPlayerId(room, playerId) {
    if (room.participants.attack.playerId === playerId) {
        return {
            participant: "attack",
            data: room.participants.attack
        };
    }
    if (room.participants.defense.playerId === playerId) {
        return {
            participant: "defense",
            data: room.participants.defense
        };
    }
    return null;
}

function normalizePlayerId(body = {}) {
    if (typeof body.playerId !== "string") {
        return null;
    }
    const playerId = body.playerId.trim();
    if (!playerId || playerId.length > 128) {
        return null;
    }
    return playerId;
}

function getPlayerAccess(room, playerId) {
    if (!room || !playerId) {
        return null;
    }
    const participantInfo = getParticipantByPlayerId(room, playerId);
    if (!participantInfo) {
        return null;
    }
    const participant = participantInfo.participant;
    let role = null;
    if (room.roles.attack === participant) {
        role = "attack";
    } else if (room.roles.defense === participant) {
        role = "defense";
    }
    if (!role) {
        return null;
    }
    return {
        playerId: playerId,
        participant: participant,
        role: role,
        participantData: participantInfo.data
    };
}

function requireRoomPlayer(room, body) {
    const playerId = normalizePlayerId(body);
    if (!playerId) {
        return {
            ok: false,
            status: 400,
            response: {
                error: "playerId is required",
                reason: "missing_player_id"
            }
        };
    }
    const access = getPlayerAccess(room, playerId);
    if (!access) {
        return {
            ok: false,
            status: 403,
            response: {
                error: "Player is not in this room",
                reason: "player_not_in_room"
            }
        };
    }
    return {
        ok: true,
        access: access
    };
}

function ensureRoomLifecycle(room) {
    if (!room) {
        return;
    }
    const now = Date.now();
    if (!Number.isFinite(room.createdAt)) {
        room.createdAt = now;
    }
    if (!Number.isFinite(room.lastActivityAt)) {
        room.lastActivityAt = room.createdAt;
    }
    if (!Object.prototype.hasOwnProperty.call(room, "finalResultAt")) {
        room.finalResultAt = null;
    }
    if (!Object.prototype.hasOwnProperty.call(room, "closedAt")) {
        room.closedAt = null;
    }
    if (!room.connectionState || typeof room.connectionState !== "object") {
        room.connectionState = {
            attack: {
                lastSeenAt: null
            },
            defense: {
                lastSeenAt: null
            }
        };
    }
    if (!room.connectionState.attack || typeof room.connectionState.attack !== "object") {
        room.connectionState.attack = {
            lastSeenAt: null
        };
    }
    if (!room.connectionState.defense || typeof room.connectionState.defense !== "object") {
        room.connectionState.defense = {
            lastSeenAt: null
        };
    }
    if (!Object.prototype.hasOwnProperty.call(room.connectionState.attack, "lastSeenAt")) {
        room.connectionState.attack.lastSeenAt = null;
    }
    if (!Object.prototype.hasOwnProperty.call(room.connectionState.defense, "lastSeenAt")) {
        room.connectionState.defense.lastSeenAt = null;
    }
}

function touchRoomActivity(room) {
    if (!room) {
        return;
    }
    ensureRoomLifecycle(room);
    room.lastActivityAt = Date.now();
}

function touchParticipantPresence(room, participant) {
    if (!room) {
        return;
    }
    if (participant !== "attack" && participant !== "defense") {
        return;
    }
    ensureRoomLifecycle(room);
    room.connectionState[participant].lastSeenAt = Date.now();
}

function isParticipantConnected(room, participant, now = Date.now()) {
    if (!room) {
        return false;
    }
    if (participant !== "attack" && participant !== "defense") {
        return false;
    }
    ensureRoomLifecycle(room);
    const lastSeenAt = room.connectionState[participant].lastSeenAt;
    if (!Number.isFinite(lastSeenAt)) {
        return false;
    }
    return now - lastSeenAt <= PLAYER_DISCONNECT_AFTER_MS;
}

function getRoomConnectionState(room) {
    const now = Date.now();

    ensureRoomLifecycle(room);

    const state = {
        attack: {
            connected:
                isParticipantConnected(room, "attack", now),
            lastSeenAt:
                room.connectionState.attack.lastSeenAt
        },
        defense: {
            connected:
                isParticipantConnected(room, "defense", now),
            lastSeenAt:
                room.connectionState.defense.lastSeenAt
        }
    };

    if (
        room.type === "cpu" &&
        room.cpu?.participant &&
        state[room.cpu.participant]
    ) {
        state[room.cpu.participant] = {
            connected: true,
            lastSeenAt: null
        };
    }

    return state;
}

function getLatestRoomTimestamp(room) {
    ensureRoomLifecycle(room);
    const timestamps = [ room.createdAt, room.lastActivityAt, room.connectionState.attack.lastSeenAt, room.connectionState.defense.lastSeenAt ].filter(value => Number.isFinite(value));
    if (timestamps.length === 0) {
        return Date.now();
    }
    return Math.max(...timestamps);
}

function createParticipantReward(roomId, room, participant) {
    const reward = room.rewardResult;
    if (!reward) {
        return {
            eligible: false,
            reason: "reward_not_ready"
        };
    }
    if (!reward.applied) {
        return {
            eligible: false,
            reason: reward.reason || "reward_not_applied",
            roomId: roomId,
            matchNumber: room.matchNumber ?? 1,
            participant: participant
        };
    }
    if (room.type === "cpu") {
        if (
            participant !==
            reward.humanParticipant
        ) {
            return {
                eligible: false,
                reason: "cpu_not_human_player"
            };
        }

        const matchNumber =
            room.matchNumber ?? 1;

        return {
            eligible: true,
            mode: "cpu",
            rewardId:
                roomId +
                "_" +
                matchNumber +
                "_" +
                participant,
            roomId,
            matchNumber,
            participant,
            point: Number(
                reward.humanPoint ?? 0
            ),
            result:
                reward.result || "lose",
            winner:
                reward.winner,
            diff:
                reward.diff,
            rewardMatchCount:
                reward.rewardMatchCount,
            rewardDate: getJstDateKey(
                room.finalResultAt || Date.now()
            )
        };
    }
    
    const point = participant === "attack" ? reward.attackPoint : reward.defensePoint;
    let result = "lose";
    if (reward.winner === "draw") {
        result = "draw";
    } else if (reward.winner === participant) {
        result = "win";
    }
    const matchNumber = room.matchNumber ?? 1;
    const rewardId = roomId + "_" + matchNumber + "_" + participant;
    return {
        eligible: true,
        rewardId: rewardId,
        roomId: roomId,
        matchNumber: matchNumber,
        participant: participant,
        point: Number(point ?? 0),
        result: result,
        winner: reward.winner,
        diff: reward.diff,
        rewardMatchCount: reward.rewardMatchCount,
        rewardRemainingCount: reward.rewardRemainingCount
    };
}


app.post("/api/placement/place/:roomId", (req, res) => {
    const room = rooms[req.params.roomId];

    if (!room) {
        return res.status(404).json({
            error: "Room not found",
            reason: "room_not_found"
        });
    }

    const auth = requireRoomPlayer(room, req.body);

    if (!auth.ok) {
        return res
            .status(auth.status)
            .json(auth.response);
    }

    const result = applyPlacementCard(
        room,
        auth.access.role,
        req.body?.card
    );

    if (!result.ok) {
        return res.status(result.status).json({
            error: result.error,
            reason: result.reason
        });
    }

    runCpuPlacement(room);
    runCpuOpen(room);

    const attackPlayer =
        getRolePlayer(room, "attack");

    const defensePlayer =
        getRolePlayer(room, "defense");

    return res.json({
        success: true,
        phase: room.phase,
        role: auth.access.role,
        attackCount:
            attackPlayer.placedCards.length,
        defenseCount:
            defensePlayer.placedCards.length,
        placementInfo: {
            attackCount:
                attackPlayer.placedCards.length,
            defenseCount:
                defensePlayer.placedCards.length,
            attackCards:
                attackPlayer.placedCards,
            defenseCards:
                defensePlayer.placedCards
        },
        openInfo: room.openInfo,
        battleState: room.battleState
    });
});

app.post("/api/open/:roomId", (req, res) => {
    const room = rooms[req.params.roomId];

    if (!room) {
        return res.status(404).json({
            error: "Room not found",
            reason: "room_not_found"
        });
    }

    const auth = requireRoomPlayer(room, req.body);

    if (!auth.ok) {
        return res
            .status(auth.status)
            .json(auth.response);
    }

    const result = applyOpenSelection(
        room,
        auth.access.role,
        req.body?.selectedIndexes
    );

    if (!result.ok) {
        return res.status(result.status).json({
            error: result.error,
            reason: result.reason
        });
    }

    runCpuOpen(room);
    runCpuBattle(room);
    runCpuReplace(room);

    return res.json({
        success: true,
        phase: room.phase,
        role: auth.access.role,
        openInfo: room.openInfo,
        openReady: room.openReady,
        battleState: room.battleState
    });
});

app.post("/api/open-ready/:roomId", (req, res) => {
    const room = rooms[req.params.roomId];

    if (!room) {
        return res.status(404).json({
            error: "Room not found",
            reason: "room_not_found"
        });
    }

    const auth = requireRoomPlayer(room, req.body);

    if (!auth.ok) {
        return res
            .status(auth.status)
            .json(auth.response);
    }

    const result = applyOpenReady(
        room,
        auth.access.role
    );

    if (!result.ok) {
        return res.status(result.status).json({
            error: result.error,
            reason: result.reason
        });
    }

    runCpuOpen(room);
    runCpuBattle(room);
    runCpuReplace(room);

    return res.json({
        success: true,
        waiting: room.phase === "open",
        role: auth.access.role,
        phase: room.phase,
        openInfo: room.openInfo,
        openReady: room.openReady,
        battleState: room.battleState
    });
});


app.post("/api/attack/place/:roomId", (req, res) => {
    const room = rooms[req.params.roomId];

    if (!room) {
        return res.status(404).json({
            error: "Room not found",
            reason: "room_not_found"
        });
    }

    const auth = requireRoomPlayer(
        room,
        req.body
    );

    if (!auth.ok) {
        return res
            .status(auth.status)
            .json(auth.response);
    }

    const result = applyBattleAction(
        room,
        auth.access.role,
        {
            cardIndex: req.body?.cardIndex,
            face: req.body?.face,
            position: req.body?.position
        }
    );

    if (!result.ok) {
        return res.status(result.status).json({
            error: result.error,
            reason: result.reason
        });
    }

    runCpuBattle(room);
    runCpuReplace(room);

    return res.json({
        success: true,
        phase: room.phase,
        battleState: room.battleState
    });
});

app.post("/api/replace/:roomId", (req, res) => {
    const room = rooms[req.params.roomId];

    if (!room) {
        return res.status(404).json({
            error: "Room not found",
            reason: "room_not_found"
        });
    }

    const auth =
        requireRoomPlayer(room, req.body);

    if (!auth.ok) {
        return res
            .status(auth.status)
            .json(auth.response);
    }

    const result =
        applyReplaceAction(
            room,
            auth.access.role,
            req.body?.index
        );

    if (!result.ok) {
        return res.status(result.status).json({
            error: result.error,
            reason: result.reason
        });
    }

    runCpuReplace(room);
    runCpuRoundResult(room);

    return res.json({
        success: true,
        phase: room.phase,
        battleState: room.battleState,
        lastReplaceIndex:
            room.lastReplaceIndex ?? null,
        nextRoundReady:
            room.nextRoundReady ?? null
    });
});


function finalizeRound(room) {
    ensureRoomLifecycle(room);
    const bs = room.battleState;
    if (!bs || !Array.isArray(bs.pointArea)) {
        throw new Error("Battle state not found");
    }
    const binary = bs.pointArea.map(point => point.card).join("");
    const score = parseInt(binary, 2);
    const attackParticipant = room.roles.attack;
    room.totalScore[attackParticipant] += score;
    room.finalBinary[attackParticipant] = binary;
    bs.finalBinary = binary;
    bs.finalScore = score;
    bs.currentRole = null;
    room.lastReplaceIndex = null;
    touchRoomActivity(room);
    if (room.round === 1) {
        room.nextRoundReady = {
            attack: false,
            defense: false
        };
        room.finalResultAt = null;
        room.closedAt = null;
        room.phase = "round_result";

        runCpuRoundResult(room);
        return;
    }
    room.nextRoundReady = null;
    room.rematchState = {
        attack: null,
        defense: null
    };
    applyRandomMatchReward(room);
    room.finalResultAt = Date.now();
    room.closedAt = null;
    room.phase = "final_result";
}

app.post("/api/next-round/:roomId", (req, res) => {
    const room = rooms[req.params.roomId];

    if (!room) {
        return res.status(404).json({
            error: "Room not found",
            reason: "room_not_found"
        });
    }

    const auth = requireRoomPlayer(
        room,
        req.body
    );

    if (!auth.ok) {
        return res
            .status(auth.status)
            .json(auth.response);
    }

    const result = applyNextRoundReady(
        room,
        auth.access.role
    );

    if (!result.ok) {
        return res.status(result.status).json({
            error: result.error,
            reason: result.reason
        });
    }

    runCpuRoundResult(room);

    return res.json({
        success: true,
        waiting: room.phase === "round_result",
        role: auth.access.role,
        phase: room.phase,
        round: room.round,
        roles: room.roles,
        nextRoundReady:
            room.nextRoundReady ?? null
    });
});

app.post("/api/match-end-choice/:roomId", (req, res) => {
    const roomId = req.params.roomId;
    const room = rooms[roomId];

    if (!room) {
        return res.status(404).json({
            error: "Room not found",
            reason: "room_not_found"
        });
    }

    if (room.phase !== "final_result") {
        return res.status(400).json({
            error: "Not final result phase",
            reason: "invalid_phase"
        });
    }

    const auth =
        requireRoomPlayer(room, req.body);

    if (!auth.ok) {
        return res
            .status(auth.status)
            .json(auth.response);
    }

    const participant =
        auth.access.participant;

    const action =
        req.body?.action;

    if (
        action !== "rematch" &&
        action !== "exit"
    ) {
        return res.status(400).json({
            error: "Invalid action",
            reason: "invalid_action"
        });
    }

    /* CPU対戦 */

    if (room.type === "cpu") {
        const humanParticipant =
            room.cpu?.humanParticipant ||
            getCpuHumanParticipant(room);

        if (
            !humanParticipant ||
            participant !== humanParticipant
        ) {
            return res.status(403).json({
                error: "Only the human player can select",
                reason: "human_player_only"
            });
        }

        if (action === "exit") {
            touchRoomActivity(room);
            removeRoomAndRelatedTickets(roomId);

            return res.json({
                success: true,
                cpuMatch: true,
                alreadySelected: false,
                action,
                participant,
                phase: "closed",
                roomRemoved: true,
                rematchStarted: false
            });
        }

        const humanFirstRole =
            prepareCpuRematchRoles(room);

        if (!humanFirstRole) {
            return res.status(500).json({
                error: "CPU rematch role could not be prepared",
                reason: "cpu_rematch_role_failed"
            });
        }

        resetRoomForRematch(room);

        return res.json({
            success: true,
            cpuMatch: true,
            alreadySelected: false,
            action,
            participant,
            phase: room.phase,
            round: room.round,
            roles: room.roles,
            humanFirstRole,
            firstRoleSetting:
                room.cpu?.firstRoleSetting,
            difficulty:
                room.cpu?.difficulty ||
                "standard",
            matchNumber:
                room.matchNumber ?? 1,
            rematchStarted: true,
            rematchState:
                room.rematchState,
            matchEnd: {
                attack: null,
                defense: null
            }
        });
    }

    /* 手動対戦・ランダム対戦 */

    if (!room.rematchState) {
        room.rematchState = {
            attack: null,
            defense: null
        };
    }

    const existingAction =
        room.rematchState[participant];

    if (existingAction === action) {
        return res.json({
            success: true,
            alreadySelected: true,
            action,
            participant,
            phase: room.phase,
            rematchState: room.rematchState,
            matchEnd: {
                attack:
                    room.rematchState.attack,
                defense:
                    room.rematchState.defense
            }
        });
    }

    if (
        existingAction !== null &&
        existingAction !== undefined
    ) {
        return res.status(409).json({
            error:
                "Match end choice already selected",
            reason:
                "choice_already_selected"
        });
    }

    room.rematchState[participant] =
        action;

    touchRoomActivity(room);

    const attackChoice =
        room.rematchState.attack;

    const defenseChoice =
        room.rematchState.defense;

    if (
        attackChoice === "rematch" &&
        defenseChoice === "rematch"
    ) {
        resetRoomForRematch(room);

        return res.json({
            success: true,
            alreadySelected: false,
            rematchStarted: true,
            action,
            participant,
            phase: room.phase,
            round: room.round,
            roles: room.roles,
            rematchState:
                room.rematchState,
            matchEnd: {
                attack: null,
                defense: null
            }
        });
    }

    return res.json({
        success: true,
        alreadySelected: false,
        rematchStarted: false,
        action,
        participant,
        phase: room.phase,
        rematchState: room.rematchState,
        matchEnd: {
            attack:
                room.rematchState.attack,
            defense:
                room.rematchState.defense
        }
    });
});

app.post("/api/reward-claim-info/:roomId", requireWixBackend, (req, res) => {
    cleanupRooms();
    const roomId = req.params.roomId;
    const room = rooms[roomId];
    if (!room) {
        return res.status(404).json({
            error: "Room not found",
            reason: "room_not_found"
        });
    }
    const playerId = typeof req.body?.playerId === "string" ? req.body.playerId.trim() : "";
    if (!playerId) {
        return res.status(400).json({
            error: "playerId is required",
            reason: "missing_player_id"
        });
    }
    const participantInfo = getParticipantByPlayerId(room, playerId);
    if (!participantInfo) {
        return res.status(403).json({
            error: "Player is not in this room",
            reason: "player_not_in_room"
        });
    }
    if (
        room.type !== "random" &&
        room.type !== "cpu"
    ) {
        return res.json({
            eligible: false,
            reason: "not_reward_match"
        });
    }
    if (
        room.type === "random" &&
        room.participants.attack.memberId &&
        room.participants.attack.memberId ===
            room.participants.defense.memberId
    ) {
        return res.json({
            eligible: false,
            reason: "same_member_id"
        });
    }
    if (room.phase !== "final_result") {
        return res.json({
            eligible: false,
            reason: "match_not_finished"
        });
    }
    const participant = participantInfo.participant;
    const participantData = participantInfo.data;
    if (!participantData.memberId) {
        return res.json({
            eligible: false,
            reason: "missing_member_id"
        });
    }
    const reward = createParticipantReward(roomId, room, participant);
    if (!reward.eligible) {
        return res.json(reward);
    }
    return res.json({
        ...reward,
        memberId: participantData.memberId
    });
});

const cleanupTimer = setInterval(() => {
    try {
        cleanupRandomTickets();
        cleanupRooms();
    } catch (error) {
        console.error("[Cleanup] Unexpected error:", error);
    }
}, ROOM_CLEANUP_INTERVAL_MS);

if (typeof cleanupTimer.unref === "function") {
    cleanupTimer.unref();
}

const PORT = process.env.PORT || 3e3;

app.listen(PORT, () => {
    console.log("Binary Shift Server is running on port " + PORT);
});

