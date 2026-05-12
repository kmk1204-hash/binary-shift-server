import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const rooms = {};

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
  room.players.attack.hand = [...room.players.attack.placedCards];
  room.players.defense.hand = [...room.players.defense.placedCards];

  room.battleState = {
    step: 1,
    currentRole: "attack",
    forcedFace: null,

    attackHand: room.players.attack.hand.map(c => ({
      value: c,
      owner: "attack"
    })),

    defenseHand: room.players.defense.hand.map(c => ({
      value: c,
      owner: "defense"
    })),

    pointArea: Array(6).fill(null)
  };
}

/* =====================
   ルーム作成
===================== */
app.get("/api/create-room", (req, res) => {
  const roomId = Math.random().toString(36).substring(2, 8);

  rooms[roomId] = {
    phase: "placement",
    round: 1,

    totalScore: {
      attack: 0,
      defense: 0
    },

    finalBinary: {
      attack: null,
      defense: null
    },

    players: {
      attack: { placedCards: [], hand: [] },
      defense: { placedCards: [], hand: [] }
    },

    battleState: null,
    openInfo: null,
    lastReplaceIndex: null,
    nextRoundReady: null
  };

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
   openフェーズ
===================== */
app.post("/api/open/:roomId", (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: "Room not found" });

  const { role, zeroCount, oneCount } = req.body;

  if (room.phase !== "open") {
    return res.status(400).json({ error: "Not open phase" });
  }

  if (role !== "defense") {
    return res.status(400).json({ error: "Only defense can open" });
  }

  const z = Number(zeroCount);
  const o = Number(oneCount);

  if (!Number.isInteger(z) || !Number.isInteger(o)) {
    return res.status(400).json({ error: "Invalid open counts" });
  }

  if (z < 0 || o < 0) {
    return res.status(400).json({ error: "Invalid open counts" });
  }

  const total = z + o;

  if (total > 3) {
    return res.status(400).json({ error: "Too many open cards" });
  }

  const defenseCards = room.players.defense.placedCards;
  const attackCards = room.players.attack.placedCards;

  if (defenseCards.length !== 3 || attackCards.length !== 3) {
    return res.status(400).json({ error: "Build not completed" });
  }

  const defenseCardCounts = countCards(defenseCards);

  if (z > defenseCardCounts.zeroCount) {
    return res.status(400).json({ error: "Too many zero cards opened" });
  }

  if (o > defenseCardCounts.oneCount) {
    return res.status(400).json({ error: "Too many one cards opened" });
  }

  const scoutCount = Math.max(0, total - 1);
  const attackScouted = makeScoutCounts(attackCards, scoutCount);

  room.openInfo = {
    completed: true,

    defenseOpen: {
      zeroCount: z,
      oneCount: o,
      total
    },

    attackScouted
  };

  // open完了 → battle開始
  room.phase = "battle";
  initializeBattleState(room);

  return res.json({
    success: true,
    phase: room.phase,
    openInfo: room.openInfo,
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
