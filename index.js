import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const rooms = {};
let waitingRandomTicketId = null;
const randomTickets = {};

const RANDOM_TICKET_TTL_MS = 1000 * 60 * 3; // 3分

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
   ルーム作成
===================== */
app.get("/api/create-room", (req, res) => {
  const roomId = generateRoomId();

  rooms[roomId] = createInitialRoom();

  res.json({ roomId });
});
/* =====================
   ルーム参加
===================== */
app.get("/api/join-room/:roomId", (req, res) => {
  const room = rooms[req.params.roomId];

  if (!room) {
    return res.status(404).json({ error: "Room not found" });
  }

  res.json({ success: true });
});

/* =====================
   ランダムマッチ開始
===================== */
app.post("/api/random-match", (req, res) => {
  cleanupRandomTickets();

  const { clientId } = req.body;

  if (!clientId) {
    return res.status(400).json({ error: "clientId is required" });
  }

  // 同じclientがすでに待機中なら、新しいticketを作らず既存ticketを返す
  const existingWaitingTicketId = findWaitingTicketByClientId(clientId);

  if (existingWaitingTicketId) {
    return res.json({
      matched: false,
      ticketId: existingWaitingTicketId
    });
  }

  const ticketId = generateTicketId();

  randomTickets[ticketId] = {
    matched: false,
    roomId: null,
    role: null,
    clientId,
    createdAt: Date.now()
  };

  // 待機者がいない場合：自分が待機
  if (!waitingRandomTicketId || !randomTickets[waitingRandomTicketId]) {
    waitingRandomTicketId = ticketId;

    return res.json({
      matched: false,
      ticketId
    });
  }

  const firstTicketId = waitingRandomTicketId;
  const firstTicket = randomTickets[firstTicketId];

  // 待機者が自分自身ならマッチさせない
  if (firstTicket && firstTicket.clientId === clientId) {
    return res.json({
      matched: false,
      ticketId: firstTicketId
    });
  }

  // 待機者が壊れていた場合
  if (!firstTicket || firstTicket.matched) {
    waitingRandomTicketId = ticketId;

    return res.json({
      matched: false,
      ticketId
    });
  }

  // 待機者がいる場合：マッチ成立
  const secondTicketId = ticketId;

  const roomId = generateRoomId();
  rooms[roomId] = createInitialRoom();

  randomTickets[firstTicketId] = {
    ...randomTickets[firstTicketId],
    matched: true,
    roomId,
    role: "attack",
    matchedAt: Date.now()
  };

  randomTickets[secondTicketId] = {
    ...randomTickets[secondTicketId],
    matched: true,
    roomId,
    role: "defense",
    matchedAt: Date.now()
  };

  waitingRandomTicketId = null;

  return res.json({
    matched: true,
    ticketId: secondTicketId,
    roomId,
    role: "defense"
  });
});

/* =====================
   ランダムマッチ状態確認
===================== */
app.get("/api/random-match/:ticketId", (req, res) => {
  cleanupRandomTickets();
  
  const ticket = randomTickets[req.params.ticketId];

  if (!ticket) {
    return res.status(404).json({ error: "Ticket not found" });
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
    role: ticket.role
  });
});

/* =====================
   ランダムマッチキャンセル
===================== */
app.post("/api/random-match-cancel", (req, res) => {
  cleanupRandomTickets();

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
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: "Room not found" });

  const placementInfo = {
    attackCount: room.players.attack.placedCards.length,
    defenseCount: room.players.defense.placedCards.length,
    attackCards: room.players.attack.placedCards,
    defenseCards: room.players.defense.placedCards
  };

  if (room.phase === "final_result") {
    const attackScore = room.totalScore.attack;
    const defenseScore = room.totalScore.defense;

    let winner = "draw";
    if (attackScore > defenseScore) winner = "attack";
    if (defenseScore > attackScore) winner = "defense";

    return res.json({
      phase: room.phase,
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
      nextRoundReady: room.nextRoundReady ?? null
    });
  }

  return res.json({
    phase: room.phase,
    battleState: room.battleState,
    round: room.round,
    totalScore: room.totalScore,
    placementInfo,
    openInfo: room.openInfo ?? null,
    openReady: room.openReady ?? null,
    lastReplaceIndex: room.lastReplaceIndex ?? null,
    nextRoundReady: room.nextRoundReady ?? null
  });
});
/* =====================
   配置フェーズ
   ※ 実質 build：3枚のカード選択
===================== */
app.post("/api/placement/place/:roomId", (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: "Room not found" });

  const { role, card } = req.body;

  if (room.phase !== "placement") {
    return res.status(400).json({ error: "Not placement phase" });
  }

  if (role !== "attack" && role !== "defense") {
    return res.status(400).json({ error: "Invalid role" });
  }

  if (card !== 0 && card !== 1) {
    return res.status(400).json({ error: "Invalid card" });
  }

  const player = room.players[role];
  if (!player) {
    return res.status(400).json({ error: "Player not found" });
  }

  if (player.placedCards.length >= 3) {
    return res.status(400).json({ error: "Already placed" });
  }

  player.placedCards.push(card);

  const attackCount = room.players.attack.placedCards.length;
  const defenseCount = room.players.defense.placedCards.length;

  /* ===== build完了 → openへ ===== */
  if (attackCount === 3 && defenseCount === 3) {
    room.phase = "open";
    room.openInfo = createEmptyOpenInfo();

    // open完了までbattleStateは作らない
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
      attackCards: room.players.attack.placedCards,
      defenseCards: room.players.defense.placedCards
    },
    openInfo: room.openInfo,
    battleState: room.battleState
  });
});

/* =====================
   openフェーズ：defenseが公開情報を確定
===================== */
app.post("/api/open/:roomId", (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: "Room not found" });

  const { role, selectedIndexes } = req.body;

  if (room.phase !== "open") {
    return res.status(400).json({ error: "Not open phase" });
  }

  if (role !== "defense") {
    return res.status(400).json({ error: "Only defense can open" });
  }

  if (room.openInfo && room.openInfo.completed) {
    return res.status(400).json({ error: "Open already completed" });
  }

  if (!Array.isArray(selectedIndexes)) {
    return res.status(400).json({ error: "Invalid selected indexes" });
  }

  if (selectedIndexes.length > 3) {
    return res.status(400).json({ error: "Too many selected cards" });
  }

  const defenseCards = room.players.defense.placedCards;
  const attackCards = room.players.attack.placedCards;

  if (defenseCards.length !== 3 || attackCards.length !== 3) {
    return res.status(400).json({ error: "Build not completed" });
  }

  const indexSet = new Set();

  for (const rawIndex of selectedIndexes) {
    const index = Number(rawIndex);

    if (!Number.isInteger(index)) {
      return res.status(400).json({ error: "Invalid selected index" });
    }

    if (index < 0 || index > 2) {
      return res.status(400).json({ error: "Selected index out of range" });
    }

    if (indexSet.has(index)) {
      return res.status(400).json({ error: "Duplicate selected index" });
    }

    indexSet.add(index);
  }

  // indexはここで集計にだけ使い、保存しない
  const selectedCards = [...indexSet].map(index => defenseCards[index]);
  const defenseOpen = countCards(selectedCards);

  const scoutCount = Math.max(0, defenseOpen.total - 1);
  const attackScouted = makeScoutCounts(attackCards, scoutCount);

  room.openInfo = {
    completed: true,
    defenseOpen,
    attackScouted
  };

  // 両者確認待ち
  room.openReady = {
    attack: false,
    defense: false
  };

  // ここではまだbattleへ進めない
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

  const place = (card, owner, faceValue, pos) => {
    if (bs.pointArea[pos]) throw new Error("Position filled");

    bs.pointArea[pos] = {
      card,
      owner,
      face: faceValue,
      placedBy: bs.currentRole
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

      const owner = bs.attackHand.length ? "attack" : "defense";
      const pos = bs.pointArea.findIndex(p => !p);
      if (pos === -1) throw new Error("No empty position");

      place(lastCard.value, owner, "表", pos);

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

  const binary = bs.pointArea.map(p => p.card).join("");
  const score = parseInt(binary, 2);

  // 現在のattackプレイヤーにスコア加算
  room.totalScore.attack += score;

  // 現在のattackプレイヤーの最終二進数を保存
  room.finalBinary.attack = binary;

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
    room.phase = "final_result";
  }
}
/* =====================
   次ラウンド
===================== */
app.post("/api/next-round/:roomId", (req, res) => {
  const room = rooms[req.params.roomId];
  const { role } = req.body;

  if (!room) {
    return res.status(404).json({ error: "Room not found" });
  }

  if (room.phase !== "round_result") {
    return res.status(400).json({ error: "Invalid phase" });
  }

  if (room.round !== 1) {
    return res.status(400).json({ error: "Invalid round" });
  }

  if (role !== "attack" && role !== "defense") {
    return res.status(400).json({ error: "Invalid role" });
  }

  if (!room.nextRoundReady) {
    room.nextRoundReady = {
      attack: false,
      defense: false
    };
  }

  room.nextRoundReady[role] = true;

  if (!room.nextRoundReady.attack || !room.nextRoundReady.defense) {
    return res.json({
      success: true,
      waiting: true,
      phase: room.phase,
      round: room.round,
      nextRoundReady: room.nextRoundReady
    });
  }

  room.round = 2;

  // 攻守入替
  const tempPlayer = room.players.attack;
  room.players.attack = room.players.defense;
  room.players.defense = tempPlayer;

  // スコアもプレイヤーに合わせて入替
  const tempScore = room.totalScore.attack;
  room.totalScore.attack = room.totalScore.defense;
  room.totalScore.defense = tempScore;

  // 最終二進数もプレイヤーに合わせて入替
  const tempBinary = room.finalBinary.attack;
  room.finalBinary.attack = room.finalBinary.defense;
  room.finalBinary.defense = tempBinary;

  // build用にリセット
  room.players.attack.placedCards = [];
  room.players.defense.placedCards = [];

  room.players.attack.hand = [];
  room.players.defense.hand = [];

  room.battleState = null;
  room.openInfo = null;
  room.openReady = null;
  room.lastReplaceIndex = null;
  room.nextRoundReady = null;
  room.phase = "placement";

  return res.json({
    success: true,
    waiting: false,
    phase: room.phase,
    round: room.round,
    totalScore: room.totalScore,
    nextRoundReady: room.nextRoundReady,
    openInfo: room.openInfo
  });
});
/* =====================
   起動
===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running");
});
