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

    // ★ 必ず attack から開始
    currentActor: "attack",

    pointArea: [null, null, null, null, null, null],

    players: {
      attack: { placedCards: [], hand: [], score: 0 },
      defense: { placedCards: [], hand: [], score: 0 }
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

  // ★ ここでは何も変更しない（超重要）
  res.json({ role: "defense" });
});

/* =====================
   ルーム状態取得
===================== */
app.get("/api/room-state/:roomId", (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) {
    return res.status(404).json({ error: "not found" });
  }

  res.json({
    phase: room.phase,
    currentActor: room.currentActor,
    battleState: room.battleState || null
  });
});


/* =====================
   配置フェーズ
===================== */
app.post("/api/placement/place/:roomId", (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) {
    return res.status(404).json({ error: "Room not found" });
  }

  const { role, card } = req.body;

  if (room.phase !== "placement") {
    return res.status(400).json({ error: "Not placement phase" });
  }

  // ★ 手番チェック
  if (room.currentActor !== role) {
    return res.status(400).json({ error: "Not your turn" });
  }

  // ★ 配置
  room.players[role].placedCards.push(card);

  // ★ 手番切り替え（最重要）
  room.currentActor = role === "attack" ? "defense" : "attack";

  // ★ 両者3枚ずつ置いたら攻撃フェーズへ
  if (
    room.players.attack.placedCards.length === 3 &&
    room.players.defense.placedCards.length === 3
  ) {
    room.phase = "attack";
    room.currentActor = "attack";

    room.players.attack.hand = [...room.players.attack.placedCards];
    room.players.defense.hand = [...room.players.defense.placedCards];

    room.battleState = {
      step: 1,
      turn: 1,                 // 1=先手 2=後手
      currentRole: "attack",

      pickFrom: "self",
      forcedFace: null,

      attackHand: [...room.players.attack.hand],
      defenseHand: [...room.players.defense.hand],

      pointArea: Array(6).fill(null)
    };
  }

  res.json({
    success: true,
    phase: room.phase,
    currentActor: room.currentActor
  });
});

/* =====================
   攻撃フェーズ（手順①）
===================== */
app.post("/api/attack/place/:roomId", (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: "Room not found" });

  if (room.phase !== "attack") {
    return res.status(400).json({ error: "Not attack phase" });
  }

  const bs = room.battleState;
  const { role, cardIndex, face, position } = req.body;

  /* =====================
     攻撃側（先手）
  ===================== */
  if (bs.step === 1 && bs.turn === "attack") {
    if (role !== "attack") {
      return res.status(400).json({ error: "Not your turn" });
    }

    if (position !== 0) {
      return res.status(400).json({ error: "Must place at position 1" });
    }

    const card = bs.attackHand[cardIndex];
    if (!card) {
      return res.status(400).json({ error: "Invalid card" });
    }

    // 表伏せ自由 → 防御側に強制
    bs.forcedFace = face === "表" ? "伏せ" : "表";

    bs.pointArea[0] = {
      card,
      face,
      owner: "attack"
    };

    bs.attackHand.splice(cardIndex, 1);

    // 防御側へ
    bs.turn = "defense";

    return res.json({ success: true, battleState: bs });
  }

  /* =====================
     防御側（後手）
  ===================== */
  if (bs.step === 1 && bs.turn === "defense") {
    if (role !== "defense") {
      return res.status(400).json({ error: "Not your turn" });
    }

    if (face !== bs.forcedFace) {
      return res.status(400).json({ error: "Face rule violation" });
    }

    if (bs.pointArea[position]) {
      return res.status(400).json({ error: "Position already filled" });
    }

    // ★ 攻撃側の残りカードから選ぶ
    const card = bs.attackHand[cardIndex];
    if (!card) {
      return res.status(400).json({ error: "Invalid card" });
    }

    bs.pointArea[position] = {
      card,
      face,
      owner: "attack"
    };

    bs.attackHand.splice(cardIndex, 1);

    // 手順①完了 → 手順②へ
    bs.step = 2;
    bs.turn = "defense";
    bs.forcedFace = null;

    return res.json({ success: true, battleState: bs });
  }

  res.status(400).json({ error: "Invalid state" });
});

  /* =====================
     次フェーズ判定（今は未実装でもOK）
  ===================== */
  // step2 / step3 はここから拡張する

  res.json({
    success: true,
    battleState: bs
  });
});


/* =====================
   サーバー起動
===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Binary Shift Server running on port ${PORT}`);
});



