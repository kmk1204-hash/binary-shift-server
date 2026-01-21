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
    currentActor: "attack",

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

  // 状態は変えない
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
    battleState: room.battleState
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

  if (room.currentActor !== role) {
    return res.status(400).json({ error: "Not your turn" });
  }

  room.players[role].placedCards.push(card);

  // 手番交代
  room.currentActor = role === "attack" ? "defense" : "attack";

  // 両者3枚ずつで battle 開始
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
      turn: "attack",          // ← 文字列で統一
      forcedFace: null,

      attackHand: [...room.players.attack.hand],
      defenseHand: [...room.players.defense.hand],

      pointArea: Array(6).fill(null)
    };
  }

  res.json({ success: true });
});

/* =====================
   攻撃フェーズ：手順①
===================== */
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

  /* ===== 手順①：攻撃側 ===== */
  if (bs.step === 1 && bs.currentRole === "attack") {

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

    bs.pointArea[0] = {
      card,
      face,
      owner: "attack"
    };

    bs.attackHand.splice(cardIndex, 1);

    // ★ 表伏せルール
    bs.forcedFace = face === "表" ? "伏せ" : "表";

    // ★ 防御側へ手番移動（ここが重要）
    bs.currentRole = "defense";

    return res.json({
      success: true,
      battleState: bs
    });
  }

  res.status(400).json({ error: "Invalid state" });
});

/* =====================
   サーバー起動
===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Binary Shift Server running on port ${PORT}`);
});


