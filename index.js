import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const rooms = {};

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

    players: {
      attack: { placedCards: [], hand: [] },
      defense: { placedCards: [], hand: [] }
    },

    battleState: null
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

  // ★ 最終結果
  if (room.phase === "final_result") {
    const attackScore = room.totalScore.attack;
    const defenseScore = room.totalScore.defense;

    let winner = "draw";
    if (attackScore > defenseScore) winner = "attack";
    if (defenseScore > attackScore) winner = "defense";

    return res.json({
      phase: room.phase,
      result: { attackScore, defenseScore, winner }
    });
  }

  res.json({
    phase: room.phase,
    battleState: room.battleState,
    round: room.round,
    totalScore: room.totalScore
  });
});

/* =====================
   配置フェーズ
===================== */
app.post("/api/placement/place/:roomId", (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: "Room not found" });

  const { role, card } = req.body;

  if (room.phase !== "placement") {
    return res.status(400).json({ error: "Not placement phase" });
  }

  if (card !== 0 && card !== 1) {
    return res.status(400).json({ error: "Invalid card" });
  }

  const player = room.players[role];

  if (player.placedCards.length >= 3) {
    return res.status(400).json({ error: "Already placed" });
  }

  player.placedCards.push(card);

  const attackCount = room.players.attack.placedCards.length;
  const defenseCount = room.players.defense.placedCards.length;

  /* ===== battle開始 ===== */
  if (attackCount === 3 && defenseCount === 3) {
    room.phase = "battle";

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

  res.json({ success: true });
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

  // =====================
  // ★ ここから旧step6
  // =====================

  const lastCard = bs.attackHand[0] || bs.defenseHand[0];
  if (!lastCard) throw new Error("No card");

  const owner = bs.attackHand.length ? "attack" : "defense";
  const pos = bs.pointArea.findIndex(p => !p);
  if (pos === -1) throw new Error("No empty position");

  // 6枚目配置（自動）
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

/* =====================
   読み替え
===================== */
app.post("/api/replace/:roomId", (req, res) => {
  const room = rooms[req.params.roomId];
  const { role, index } = req.body;
  const bs = room.battleState;

  // =====================
  // ユーティリティ
  // =====================
  function hasOwnPlacedCard(bs, index, role) {
    for (let i = 0; i < 3; i++) {
      if (bs.pointArea[index + i].placedBy === role) {
        return true;
      }
    }
    return false;
  }

  // =====================
  // スキップ処理
  // =====================
  if (index === -1) {
    // 攻撃スキップ → 防御へ
    if (room.phase === "replace_attack") {
      room.phase = "replace_defense";
      return res.json({ success: true, phase: room.phase, battleState: bs });
    }

    // 防御スキップ → ラウンド終了
    if (room.phase === "replace_defense") {
      finalizeRound(room);
      return res.json({ success: true, phase: room.phase, battleState: bs });
    }
  }

  // indexの安全チェック（念のため）
  if (index < 0 || index > 3) {
    return res.status(400).json({ error: "Invalid index" });
  }

  let binary = bs.pointArea.map(p => p.card).join("");

  // =====================
  // 攻撃側 replace
  // =====================
  if (room.phase === "replace_attack") {
    if (role !== "attack") {
      return res.status(400).json({ error: "Not turn" });
    }

    // 000チェック
    if (binary.substr(index, 3) !== "000") {
      return res.status(400).json({ error: "Invalid pattern" });
    }

    // ★ 追加：自分が置いたカードが含まれているか
    if (!hasOwnPlacedCard(bs, index, "attack")) {
      return res.status(400).json({ error: "No own placed card" });
    }

    // 変換
    for (let i = 0; i < 3; i++) {
      bs.pointArea[index + i].card = "1";
    }

    room.phase = "replace_defense";
    return res.json({ success: true, phase: room.phase, battleState: bs });
  }

  // =====================
  // 防御側 replace
  // =====================
  if (room.phase === "replace_defense") {
    if (role !== "defense") {
      return res.status(400).json({ error: "Not turn" });
    }

    // 111チェック
    if (binary.substr(index, 3) !== "111") {
      return res.status(400).json({ error: "Invalid pattern" });
    }

    // ★ 追加：自分が置いたカードが含まれているか
    if (!hasOwnPlacedCard(bs, index, "defense")) {
      return res.status(400).json({ error: "No own placed card" });
    }

    // 変換
    for (let i = 0; i < 3; i++) {
      bs.pointArea[index + i].card = "0";
    }

    finalizeRound(room);
    return res.json({ success: true, phase: room.phase, battleState: bs });
  }

  // =====================
  // その他
  // =====================
  return res.status(400).json({ error: "Invalid phase" });
});
/* =====================
   ラウンド終了
===================== */
function finalizeRound(room) {
  const bs = room.battleState;

  const binary = bs.pointArea.map(p => p.card).join("");
  const score = parseInt(binary, 2);

  room.totalScore.attack += score;

  bs.finalBinary = binary;
  bs.finalScore = score;

  if (room.round === 1) {
    room.phase = "round_result";
  } else {
    room.phase = "final_result";
  }
}

/* =====================
   次ラウンド
===================== */
app.post("/api/next-round/:roomId", (req, res) => {
  const room = rooms[req.params.roomId];

  if (room.phase !== "round_result") {
    return res.status(400).json({ error: "Invalid phase" });
  }

  room.round = 2;

  // 攻守入替
  const temp = room.players.attack;
  room.players.attack = room.players.defense;
  room.players.defense = temp;

  room.players.attack.placedCards = [];
  room.players.defense.placedCards = [];

  room.phase = "placement";
  room.battleState = null;

  res.json({ success: true });
});

/* =====================
   起動
===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running");
});
