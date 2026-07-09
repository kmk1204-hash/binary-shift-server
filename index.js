import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const rooms = {};
let waitingRandomTicketId = null;
const randomTickets = {};

const accounts = {};

const RANDOM_TICKET_TTL_MS = 1000 * 60 * 3; // 3分

const ROOM_TTL_MS = 5 * 60 * 1000;

function cleanupRandomTickets() {
  const now = Date.now();

  for (const ticketId of Object.keys(randomTickets)) {
    const ticket = randomTickets[ticketId];

    if (!ticket) {
      delete randomTickets[ticketId];
      continue;
    }

    // 未マッチのまま古くなったticketを削除
    if (!ticket.matched && now - ticket.createdAt > RANDOM_TICKET_TTL_MS) {
      delete randomTickets[ticketId];

      if (waitingRandomTicketId === ticketId) {
        waitingRandomTicketId = null;
      }

      continue;
    }

    // マッチ済みticketも一定時間後に削除
    if (
      ticket.matched &&
      ticket.matchedAt &&
      now - ticket.matchedAt > RANDOM_TICKET_TTL_MS
    ) {
      delete randomTickets[ticketId];
      continue;
    }
  }

  // waitingRandomTicketId が壊れていたらリセット
  if (
    waitingRandomTicketId &&
    (
      !randomTickets[waitingRandomTicketId] ||
      randomTickets[waitingRandomTicketId].matched
    )
  ) {
    waitingRandomTicketId = null;
  }
}

/* =====================
   Room掃除
===================== */

function cleanupRooms() {

  const now = Date.now();

  for (const roomId in rooms) {

    const room = rooms[roomId];

    if (!room) {
      continue;
    }

    // 両者離脱済みならTTLを待たず削除
    if (
      room.leaveState &&
      room.leaveState.attack &&
      room.leaveState.defense
    ) {

      delete rooms[roomId];
      continue;

    }

    // 一定時間アクセスがないRoomを削除
    if (
      now - room.lastAccess >
      ROOM_TTL_MS
    ) {

      console.log(
        `Room expired: ${roomId}`
      );

      delete rooms[roomId];

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
  return Math.random().toString(36).substring(2, 12)
       + Date.now().toString(36);
}

function normalizeMemberInfo(body = {}) {

  const memberId =
    typeof body.memberId === "string" &&
    body.memberId.trim() !== ""
      ? body.memberId.trim()
      : null;

  const userName =
    typeof body.memberName === "string" &&
    body.memberName.trim() !== ""
      ? body.memberName.trim().slice(0, 24)
      : "Guest";

  return {
    memberId,
    userName
  };

}

/* =====================
   Account
===================== */

function createDefaultAccount(memberId, userName) {

  return {
    memberId,

    userName: userName || "Guest",

    point: 0,

    win: 0,

    lose: 0,

    draw: 0,

    createdAt: Date.now(),

    lastLogin: Date.now()
  };

}

function ensureAccount(memberId, userName) {

  if (!memberId) {
    return null;
  }

  if (!accounts[memberId]) {

    accounts[memberId] =
      createDefaultAccount(memberId, userName);

  } else {

    accounts[memberId].userName =
      userName || accounts[memberId].userName;

    accounts[memberId].lastLogin =
      Date.now();

  }

  return accounts[memberId];

}

function toPublicAccount(account) {

  if (!account) {
    return null;
  }

  return {
    memberId: account.memberId,
    userName: account.userName,
    point: account.point,
    win: account.win,
    lose: account.lose,
    draw: account.draw,
    createdAt: account.createdAt,
    lastLogin: account.lastLogin
  };

}

function findWaitingTicketByClientId(clientId) {
  if (!clientId) return null;

  for (const ticketId of Object.keys(randomTickets)) {
    const ticket = randomTickets[ticketId];

    if (
      ticket &&
      !ticket.matched &&
      ticket.clientId === clientId
    ) {
      return ticketId;
    }
  }

  return null;
}

function createInitialRoom(type = "manual") {

  return {

    type,

    phase: "placement",

    round: 1,

    lastAccess: Date.now(),

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

    // ゲーム進行用
    roles: {
      attack: "attack",
      defense: "defense"
    },

    // プレイヤー情報
    participants: {
      attack: {
        playerId: null,
        memberId: null,
        userName: "Guest"
      },
      defense: {
        playerId: null,
        memberId: null,
        userName: "Guest"
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

}

function getRolePlayer(room, role) {
  return room.players[role];
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

}

function resetRoomForRematch(room) {

  room.round = 1;

  room.totalScore = {
    attack: 0,
    defense: 0
  };

  room.finalBinary = {
    attack: null,
    defense: null
  };

  resetRoomForBuild(room);

  room.rematchState = {
    attack: null,
    defense: null
  };

  room.leaveState = {
    attack: false,
    defense: false
  };

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
  const shuffled = [...cards];

  // Fisher-Yates shuffle
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

  const attackPlayer =
    getRolePlayer(room, "attack");

  const defensePlayer =
    getRolePlayer(room, "defense");

  attackPlayer.hand = [...attackPlayer.placedCards];
  defensePlayer.hand = [...defensePlayer.placedCards];

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

/* =====================
   Account API
===================== */

app.post("/api/account/register", (req, res) => {

  const member =
    normalizeMemberInfo(req.body);

  if (!member.memberId) {
    return res.status(400).json({
      error: "memberId is required"
    });
  }

  const account =
    ensureAccount(
      member.memberId,
      member.userName
    );

  res.json({
    success: true,
    account: toPublicAccount(account)
  });

});

app.get("/api/account/:memberId", (req, res) => {

  const { memberId } =
    req.params;

  const account =
    accounts[memberId];

  if (!account) {
    return res.status(404).json({
      error: "Account not found"
    });
  }

  res.json({
    account: toPublicAccount(account)
  });

});

/* =====================
   ルーム作成
===================== */
app.post("/api/create-room", (req, res) => {

  const roomId = generateRoomId();

  const room = createInitialRoom("manual");

  const playerId = generatePlayerId();

  const member =
    normalizeMemberInfo(req.body);

  ensureAccount(
    member.memberId,
    member.userName
  );

  room.participants.attack.playerId =
    playerId;

  room.participants.attack.memberId =
    member.memberId;

  room.participants.attack.userName =
    member.userName;

  rooms[roomId] = room;

  res.json({
    roomId,
    playerId,
    memberId: member.memberId,
    userName: member.userName
  });

});
/* =====================
   ルーム参加
===================== */
app.post("/api/join-room/:roomId", (req, res) => {

  const room = rooms[req.params.roomId];

  if (!room) {
    return res.status(404).json({
      error: "Room not found"
    });
  }

  if (room.participants.defense.playerId !== null) {
    return res.status(400).json({
      error: "Room is full"
    });
  }

  const playerId =
    generatePlayerId();

  const member =
    normalizeMemberInfo(req.body);

  ensureAccount(
    member.memberId,
    member.userName
  );

  room.participants.defense.playerId =
    playerId;

  room.participants.defense.memberId =
    member.memberId;

  room.participants.defense.userName =
    member.userName;

  res.json({
    success: true,
    playerId,
    memberId: member.memberId,
    userName: member.userName
  });

});
/* =====================
   Room離脱
===================== */
app.post("/api/leave-room/:roomId", (req, res) => {

  cleanupRooms();

  const room = rooms[req.params.roomId];

  if (!room) {
    return res.json({ success: true });
  }

  const { role } = req.body;

  if (role !== "attack" && role !== "defense") {
    return res.status(400).json({
      error: "Invalid role"
    });
  }

  room.leaveState[role] = true;

  /* =====================
     両者離脱
  ===================== */

  if (
    room.leaveState.attack &&
    room.leaveState.defense
  ) {

    // 今後ここでポイント付与
    // if (room.type === "random") { ... }

    delete rooms[req.params.roomId];

    return res.json({
      success: true,
      deleted: true
    });

  }

  return res.json({
    success: true,
    deleted: false
  });

});

/* =====================
   ランダムマッチ開始
===================== */
app.post("/api/random-match", (req, res) => {
  cleanupRandomTickets();
  cleanupRooms();

  const { clientId } = req.body;

  const member =
    normalizeMemberInfo(req.body);

  ensureAccount(
    member.memberId,
    member.userName
  );

  if (!clientId) {
    return res.status(400).json({
      error: "clientId is required"
    });
  }

  // 同じclientがすでに待機中なら、新しいticketを作らず既存ticketを返す
  const existingWaitingTicketId =
    findWaitingTicketByClientId(clientId);

  if (existingWaitingTicketId) {
    return res.json({
      matched: false,
      ticketId: existingWaitingTicketId
    });
  }

  // 待機ticketが壊れていた場合はリセット
  if (
    waitingRandomTicketId &&
    (
      !randomTickets[waitingRandomTicketId] ||
      randomTickets[waitingRandomTicketId].matched
    )
  ) {
    waitingRandomTicketId = null;
  }

  // 待機者がいない場合：自分が待機
  if (!waitingRandomTicketId) {

    const ticketId =
      generateTicketId();

    randomTickets[ticketId] = {
      clientId,
      matched: false,
      roomId: null,
      role: null,
      playerId: null,
      memberId: member.memberId,
      userName: member.userName,
      createdAt: Date.now()
    };

    waitingRandomTicketId =
      ticketId;

    return res.json({
      matched: false,
      ticketId
    });

  }

  const firstTicketId =
    waitingRandomTicketId;

  const firstTicket =
    randomTickets[firstTicketId];

  // 念のため、待機者が自分自身ならマッチさせない
  if (
    firstTicket &&
    firstTicket.clientId === clientId
  ) {
    return res.json({
      matched: false,
      ticketId: firstTicketId
    });
  }

  // 待機者が壊れていた場合
  if (!firstTicket || firstTicket.matched) {

    const ticketId =
      generateTicketId();

    randomTickets[ticketId] = {
      clientId,
      matched: false,
      roomId: null,
      role: null,
      playerId: null,
      memberId: member.memberId,
      userName: member.userName,
      createdAt: Date.now()
    };

    waitingRandomTicketId =
      ticketId;

    return res.json({
      matched: false,
      ticketId
    });

  }

  // 待機者がいる場合：マッチ成立
  const secondTicketId =
    generateTicketId();

  randomTickets[secondTicketId] = {
    clientId,
    matched: false,
    roomId: null,
    role: null,
    playerId: null,
    memberId: member.memberId,
    userName: member.userName,
    createdAt: Date.now()
  };

  const roomId =
    generateRoomId();

  const room =
    createInitialRoom("random");

  const attackPlayerId =
    generatePlayerId();

  const defensePlayerId =
    generatePlayerId();

  room.participants.attack.playerId =
    attackPlayerId;

  room.participants.attack.memberId =
    firstTicket.memberId;

  room.participants.attack.userName =
    firstTicket.userName || "Guest";

  room.participants.defense.playerId =
    defensePlayerId;

  room.participants.defense.memberId =
    member.memberId;

  room.participants.defense.userName =
    member.userName;

  rooms[roomId] =
    room;

  randomTickets[firstTicketId] = {
    ...randomTickets[firstTicketId],
    matched: true,
    roomId,
    role: "attack",
    matchedAt: Date.now(),
    playerId: attackPlayerId
  };

  randomTickets[secondTicketId] = {
    ...randomTickets[secondTicketId],
    matched: true,
    roomId,
    role: "defense",
    matchedAt: Date.now(),
    playerId: defensePlayerId
  };

  waitingRandomTicketId =
    null;

  return res.json({
    matched: true,
    ticketId: secondTicketId,
    roomId,
    role: "defense",
    playerId: defensePlayerId,
    memberId: member.memberId,
    userName: member.userName
  });
});

/* =====================
   ランダムマッチ状態確認
===================== */
app.get("/api/random-match/:ticketId", (req, res) => {

  cleanupRandomTickets();
  cleanupRooms();

  const ticket = randomTickets[req.params.ticketId];

  if (!ticket) {
    return res.status(404).json({
      error: "Ticket not found"
    });
  }

  if (!ticket.matched) {

    return res.json({

      matched: false,

      ticketId: req.params.ticketId

    });

  }

  return res.json({

    matched: true,

    ticketId: req.params.ticketId,

    roomId: ticket.roomId,

    role: ticket.role,

    playerId: ticket.playerId

  });

});

/* =====================
   ランダムマッチキャンセル
===================== */
app.post("/api/random-match-cancel", (req, res) => {
  cleanupRandomTickets();
  cleanupRooms();

  const { ticketId } = req.body;

  if (!ticketId || !randomTickets[ticketId]) {
    return res.json({ success: true });
  }

  if (waitingRandomTicketId === ticketId) {
    waitingRandomTicketId = null;
  }

  delete randomTickets[ticketId];

  return res.json({ success: true });
});

/* =====================
   状態取得
===================== */
app.get("/api/room-state/:roomId", (req, res) => {

  cleanupRooms();

  const room = rooms[req.params.roomId];

  if (!room) {
    return res.status(404).json({
      error: "Room not found"
    });
  }

  room.lastAccess = Date.now();

  /* =====================
     現在の攻守プレイヤー取得
  ===================== */

  const attackPlayer =
    getRolePlayer(room, "attack");

  const defensePlayer =
    getRolePlayer(room, "defense");

  const placementInfo = {

    attackCount:
      attackPlayer.placedCards.length,

    defenseCount:
      defensePlayer.placedCards.length,

    attackCards:
      attackPlayer.placedCards,

    defenseCards:
      defensePlayer.placedCards

  };

  // 再戦・終了選択状況
  const matchEnd = {
    attack: room.rematchState?.attack ?? null,
    defense: room.rematchState?.defense ?? null
  };

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

      phase: room.phase,

      roles: room.roles,

      participants: room.participants,

      result: {

        attackScore,

        defenseScore,

        attackBinary: room.finalBinary.attack,

        defenseBinary: room.finalBinary.defense,

        winner

      },

      round: room.round,

      totalScore: room.totalScore,

      finalBinary: room.finalBinary,

      placementInfo,

      openInfo: room.openInfo ?? null,

      openReady: room.openReady ?? null,

      lastReplaceIndex: room.lastReplaceIndex ?? null,

      nextRoundReady: room.nextRoundReady ?? null,

      rematchState: room.rematchState,

      matchEnd

    });
  }

  return res.json({

    type: room.type,

    phase: room.phase,

    roles: room.roles,

    participants: room.participants,

    battleState: room.battleState,

    round: room.round,

    totalScore: room.totalScore,

    placementInfo,

    openInfo: room.openInfo ?? null,

    openReady: room.openReady ?? null,

    lastReplaceIndex: room.lastReplaceIndex ?? null,

    nextRoundReady: room.nextRoundReady ?? null,

    rematchState: room.rematchState,

    matchEnd
  });
});
/* =====================
   配置フェーズ
   ※ 実質 build：3枚のカード選択
===================== */
app.post("/api/placement/place/:roomId", (req, res) => {

  const room = rooms[req.params.roomId];

  if (!room) {
    return res.status(404).json({
      error: "Room not found"
    });
  }

  const { role, card } = req.body;

  if (room.phase !== "placement") {
    return res.status(400).json({
      error: "Not placement phase"
    });
  }

  if (
    role !== "attack" &&
    role !== "defense"
  ) {
    return res.status(400).json({
      error: "Invalid role"
    });
  }

  if (
    card !== 0 &&
    card !== 1
  ) {
    return res.status(400).json({
      error: "Invalid card"
    });
  }

  /* =====================
     現在の攻守プレイヤー取得
  ===================== */

  const player = getRolePlayer(room, role);

  if (!player) {
    return res.status(400).json({
      error: "Player not found"
    });
  }

  if (player.placedCards.length >= 3) {
    return res.status(400).json({
      error: "Already placed"
    });
  }

  player.placedCards.push(card);

  const attackPlayer =
    getRolePlayer(room, "attack");

  const defensePlayer =
    getRolePlayer(room, "defense");

  const attackCount =
    attackPlayer.placedCards.length;

  const defenseCount =
    defensePlayer.placedCards.length;

  /* =====================
     Build完了
  ===================== */

  if (
    attackCount === 3 &&
    defenseCount === 3
  ) {

    room.phase = "open";

    room.openInfo =
      createEmptyOpenInfo();

    room.battleState = null;

  }

  return res.json({

    success: true,

    phase: room.phase,

    attackCount,

    defenseCount,

    placementInfo: {

      attackCount,

      defenseCount,

      attackCards:
        attackPlayer.placedCards,

      defenseCards:
        defensePlayer.placedCards

    },

    openInfo:
      room.openInfo,

    battleState:
      room.battleState

  });

});

/* =====================
   openフェーズ：defenseが公開情報を確定
===================== */
app.post("/api/open/:roomId", (req, res) => {

  const room = rooms[req.params.roomId];

  if (!room) {
    return res.status(404).json({
      error: "Room not found"
    });
  }

  const { role, selectedIndexes } = req.body;

  if (room.phase !== "open") {
    return res.status(400).json({
      error: "Not open phase"
    });
  }

  if (role !== "defense") {
    return res.status(400).json({
      error: "Only defense can open"
    });
  }

  if (room.openInfo && room.openInfo.completed) {
    return res.status(400).json({
      error: "Open already completed"
    });
  }

  if (!Array.isArray(selectedIndexes)) {
    return res.status(400).json({
      error: "Invalid selected indexes"
    });
  }

  if (selectedIndexes.length > 3) {
    return res.status(400).json({
      error: "Too many selected cards"
    });
  }

  /* =====================
     現在の攻守プレイヤー取得
  ===================== */

  const defensePlayer =
    getRolePlayer(room, "defense");

  const attackPlayer =
    getRolePlayer(room, "attack");

  const defenseCards =
    defensePlayer.placedCards;

  const attackCards =
    attackPlayer.placedCards;

  if (
    defenseCards.length !== 3 ||
    attackCards.length !== 3
  ) {
    return res.status(400).json({
      error: "Build not completed"
    });
  }

  const indexSet = new Set();

  for (const rawIndex of selectedIndexes) {

    const index = Number(rawIndex);

    if (!Number.isInteger(index)) {
      return res.status(400).json({
        error: "Invalid selected index"
      });
    }

    if (index < 0 || index > 2) {
      return res.status(400).json({
        error: "Selected index out of range"
      });
    }

    if (indexSet.has(index)) {
      return res.status(400).json({
        error: "Duplicate selected index"
      });
    }

    indexSet.add(index);

  }

  const selectedCards =
    [...indexSet].map(index => defenseCards[index]);

  const defenseOpen =
    countCards(selectedCards);

  const scoutCount =
    Math.max(0, defenseOpen.total - 1);

  const attackScouted =
    makeScoutCounts(
      attackCards,
      scoutCount
    );

  room.openInfo = {

    completed: true,

    defenseOpen,

    attackScouted

  };

  room.openReady = {

    attack: false,

    defense: false

  };

  room.phase = "open";

  room.battleState = null;

  return res.json({

    success: true,

    phase: room.phase,

    openInfo: room.openInfo,

    openReady: room.openReady,

    battleState: room.battleState

  });

});

/* =====================
   open確認完了
===================== */
app.post("/api/open-ready/:roomId", (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: "Room not found" });

  const { role } = req.body;

  if (room.phase !== "open") {
    return res.status(400).json({ error: "Not open phase" });
  }

  if (role !== "attack" && role !== "defense") {
    return res.status(400).json({ error: "Invalid role" });
  }

  if (!room.openInfo || !room.openInfo.completed) {
    return res.status(400).json({ error: "Open not completed" });
  }

  if (!room.openReady) {
    room.openReady = {
      attack: false,
      defense: false
    };
  }

  room.openReady[role] = true;

  // まだ両者確認完了ではない
  if (!room.openReady.attack || !room.openReady.defense) {
    return res.json({
      success: true,
      waiting: true,
      phase: room.phase,
      openInfo: room.openInfo,
      openReady: room.openReady,
      battleState: room.battleState
    });
  }

  // 両者確認完了 → battle開始
  room.phase = "battle";
  initializeBattleState(room);

  return res.json({
    success: true,
    waiting: false,
    phase: room.phase,
    openInfo: room.openInfo,
    openReady: room.openReady,
    battleState: room.battleState
  });
});

/* =====================
   Battle（step1〜6）
===================== */
app.post("/api/attack/place/:roomId", (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: "Room not found" });
  if (room.phase !== "battle") {
    return res.status(400).json({ error: "Not battle phase" });
  }

  const bs = room.battleState;
  const { role, cardIndex, face, position } = req.body;

  const reverseFace = f => (f === "表" ? "伏せ" : "表");

  const place = (
    card,
    owner,
    faceValue,
    pos,
    placedBy = bs.currentRole
  ) => {

    if (bs.pointArea[pos]) {
      throw new Error("Position filled");
    }

    bs.pointArea[pos] = {
      card,
      owner,
      face: faceValue,
      placedBy
    };

  };

  try {

    /* ===== step1 ===== */
    if (bs.step === 1) {
      if (role !== "attack") throw new Error("Not your turn");
      if (position !== 0) throw new Error("Must left");

      const c = bs.attackHand[cardIndex];
      if (!c) throw new Error("Invalid card");

      place(c.value, "attack", face, 0);
      bs.attackHand.splice(cardIndex, 1);

      bs.forcedFace = reverseFace(face);
      bs.currentRole = "defense";
      bs.step = 2;

      return res.json({ success: true, battleState: bs });
    }

    /* ===== step2 ===== */
    if (bs.step === 2) {
      if (role !== "defense") throw new Error("Not your turn");
      if (face !== bs.forcedFace) throw new Error("Forced");

      const c = bs.attackHand[cardIndex];
      if (!c) throw new Error("Invalid card");

      place(c.value, "attack", face, position);
      bs.attackHand.splice(cardIndex, 1);

      bs.forcedFace = null;
      bs.currentRole = "defense";
      bs.step = 3;

      return res.json({ success: true, battleState: bs });
    }

    /* ===== step3 ===== */
    if (bs.step === 3) {
      if (role !== "defense") throw new Error("Not your turn");

      const c = bs.defenseHand[cardIndex];
      if (!c) throw new Error("Invalid card");

      place(c.value, "defense", face, position);
      bs.defenseHand.splice(cardIndex, 1);

      bs.forcedFace = reverseFace(face);
      bs.currentRole = "attack";
      bs.step = 4;

      return res.json({ success: true, battleState: bs });
    }

    /* ===== step4 ===== */
    if (bs.step === 4) {
      if (role !== "attack") throw new Error("Not your turn");
      if (face !== bs.forcedFace) throw new Error("Forced");

      const c = bs.defenseHand[cardIndex];
      if (!c) throw new Error("Invalid card");

      place(c.value, "defense", face, position);
      bs.defenseHand.splice(cardIndex, 1);

      bs.forcedFace = null;
      bs.currentRole = "attack";
      bs.step = 5;

      return res.json({ success: true, battleState: bs });
    }

    /* ===== step5（＋step6統合） ===== */
    if (bs.step === 5) {
      if (role !== "attack") throw new Error("Not your turn");

      const combined = [...bs.attackHand, ...bs.defenseHand];
      const c = combined[cardIndex];
      if (!c) throw new Error("Invalid card");

      // 5枚目配置
      place(c.value, c.owner, face, position);

      if (c.owner === "attack") {
        bs.attackHand = bs.attackHand.filter(x => x !== c);
      } else {
        bs.defenseHand = bs.defenseHand.filter(x => x !== c);
      }

      // ===== 自動配置（旧step6） =====
      const lastCard = bs.attackHand[0] || bs.defenseHand[0];
      if (!lastCard) throw new Error("No card");
      const owner = lastCard.owner;
      const pos = bs.pointArea.findIndex(p => !p);
      if (pos === -1) throw new Error("No empty position");

      place(
        lastCard.value,
        owner,
        "表",
        pos,
        "defense"
      );
      // 手札クリア
      bs.attackHand = [];
      bs.defenseHand = [];

      // replaceへ
      room.phase = "replace_attack";

      return res.json({
        success: true,
        phase: room.phase,
        battleState: bs
      });
    }

  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

/* =====================
   読み替え
===================== */
app.post("/api/replace/:roomId", (req, res) => {
  const room = rooms[req.params.roomId];
  const { role, index } = req.body;
  const bs = room.battleState;

  function hasOwnPlacedCard(bs, index, role) {
    for (let i = 0; i < 3; i++) {
      if (bs.pointArea[index + i].placedBy === role) {
        return true;
      }
    }
    return false;
  }

  // =====================
  // スキップ
  // =====================
  if (index === -1) {
    if (room.phase === "replace_attack") {
      room.phase = "replace_defense";
      bs.currentRole = "defense";
      room.lastReplaceIndex = null;

      return res.json({
        success: true,
        phase: room.phase,
        battleState: bs,
        lastReplaceIndex: room.lastReplaceIndex
      });
    }

    if (room.phase === "replace_defense") {
      bs.currentRole = null;
      room.lastReplaceIndex = null;
      finalizeRound(room);

      return res.json({
        success: true,
        phase: room.phase,
        battleState: bs,
        lastReplaceIndex: null
      });
    }
  }

  if (index < 0 || index > 3) {
    return res.status(400).json({ error: "Invalid index" });
  }

  const binary = bs.pointArea.map(p => p.card).join("");

  // =====================
  // attack
  // =====================
  if (room.phase === "replace_attack") {
    if (role !== "attack") {
      return res.status(400).json({ error: "Not turn" });
    }

    if (binary.substr(index, 3) !== "000") {
      return res.status(400).json({ error: "Invalid pattern" });
    }

    if (!hasOwnPlacedCard(bs, index, "attack")) {
      return res.status(400).json({ error: "No own placed card" });
    }

    for (let i = 0; i < 3; i++) {
      bs.pointArea[index + i].card = "1";
    }

    room.lastReplaceIndex = index;
    room.phase = "replace_defense";
    bs.currentRole = "defense";

    return res.json({
      success: true,
      phase: room.phase,
      battleState: bs,
      lastReplaceIndex: room.lastReplaceIndex
    });
  }

  // =====================
  // defense
  // =====================
  if (room.phase === "replace_defense") {
    if (role !== "defense") {
      return res.status(400).json({ error: "Not turn" });
    }

    if (index === room.lastReplaceIndex) {
      return res.status(400).json({ error: "Same position not allowed" });
    }

    if (binary.substr(index, 3) !== "111") {
      return res.status(400).json({ error: "Invalid pattern" });
    }

    if (!hasOwnPlacedCard(bs, index, "defense")) {
      return res.status(400).json({ error: "No own placed card" });
    }

    for (let i = 0; i < 3; i++) {
      bs.pointArea[index + i].card = "0";
    }

    bs.currentRole = null;
    room.lastReplaceIndex = null;

    finalizeRound(room);

    return res.json({
      success: true,
      phase: room.phase,
      battleState: bs,
      lastReplaceIndex: null
    });
  }

  return res.status(400).json({ error: "Invalid phase" });
});

/* =====================
   ラウンド終了
===================== */
function finalizeRound(room) {

  const bs = room.battleState;

  const binary =
    bs.pointArea.map(p => p.card).join("");

  const score =
    parseInt(binary, 2);

  /* =====================
     現在のAttackプレイヤーへ加算
  ===================== */

  const attackPlayer =
    room.roles.attack;

  room.totalScore[attackPlayer] += score;

  room.finalBinary[attackPlayer] = binary;

  bs.finalBinary = binary;
  bs.finalScore = score;
  bs.currentRole = null;

  room.lastReplaceIndex = null;

  if (room.round === 1) {

    room.nextRoundReady = {
      attack: false,
      defense: false
    };

    room.phase = "round_result";

  } else {

    room.nextRoundReady = null;

    room.rematchState = {
      attack: null,
      defense: null
    };

    room.phase = "final_result";

  }

}
/* =====================
   次ラウンド
===================== */
app.post("/api/next-round/:roomId", (req, res) => {

  const room = rooms[req.params.roomId];

  if (!room) {
    return res.status(404).json({
      error: "Room not found"
    });
  }

  if (room.phase !== "round_result") {
    return res.status(400).json({
      error: "Not round_result"
    });
  }

  if (!room.nextRoundReady) {
    room.nextRoundReady = {
      attack: false,
      defense: false
    };
  }

  const { role } = req.body;

  if (
    role !== "attack" &&
    role !== "defense"
  ) {
    return res.status(400).json({
      error: "Invalid role"
    });
  }

  room.nextRoundReady[role] = true;

  /* =====================
     相手待ち
  ===================== */

  if (
    !room.nextRoundReady.attack ||
    !room.nextRoundReady.defense
  ) {

    return res.json({
      success: true,
      waiting: true,
      phase: room.phase,
      nextRoundReady: room.nextRoundReady
    });

  }

  /* =====================
     Round2開始
  ===================== */

  room.round = 2;

  // 現在の攻守を入れ替える
  swapRoles(room);

  // Build開始用リセット
  resetRoomForBuild(room);

  return res.json({

    success: true,

    waiting: false,

    phase: room.phase,

    round: room.round,

    roles: room.roles

  });

});

/* =====================
   Match End Choice
===================== */

app.post("/api/match-end-choice/:roomId", (req, res) => {

  const room = rooms[req.params.roomId];

  if (!room) {
    return res.status(404).json({
      error: "Room not found"
    });
  }

  if (room.phase !== "final_result") {
    return res.status(400).json({
      error: "Not final_result"
    });
  }

  const { role, action } = req.body;

  if (
    role !== "attack" &&
    role !== "defense"
  ) {
    return res.status(400).json({
      error: "Invalid role"
    });
  }

  if (
    action !== "rematch" &&
    action !== "exit"
  ) {
    return res.status(400).json({
      error: "Invalid action"
    });
  }

  if (!room.rematchState) {
    room.rematchState = {
      attack: null,
      defense: null
    };
  }

  // 二重送信防止
  if (room.rematchState[role] !== null) {

    return res.json({
      success: true,
      phase: room.phase,
      rematchState: room.rematchState
    });

  }

  room.rematchState[role] = action;

  const attackChoice = room.rematchState.attack;
  const defenseChoice = room.rematchState.defense;

  /* =====================
     両者再戦
  ===================== */

  if (
    attackChoice === "rematch" &&
    defenseChoice === "rematch"
  ) {


    // 完全リセット
    resetRoomForRematch(room);

    return res.json({
      success: true,
      phase: room.phase,
      rematchState: room.rematchState
    });

  }

  /* =====================
     誰かが終了
  ===================== */

  if (
    attackChoice === "exit" ||
    defenseChoice === "exit"
  ) {


    return res.json({
      success: true,
      phase: room.phase,
      rematchState: room.rematchState
    });

  }

  /* =====================
     相手待ち
  ===================== */

  return res.json({
    success: true,
    phase: room.phase,
    rematchState: room.rematchState
  });

});

/* =====================
   起動
===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running");
});
