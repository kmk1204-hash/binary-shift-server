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
    phase: "waiting",

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
  if (!room) return res.status(404).json({ error: "Room not found" });

  room.phase = "placement";
  room.currentActor = "attack";

  res.json({ role: "defense" });
});

/* =====================
   ルーム状態取得
===================== */
app.get("/api/room-state/:roomId", (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: "Room not found" });

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
  if (!room) return res.status(404).json({ error: "Room not found" });

  const { role, card } = req.body;

  if (room.phase !== "placement") {
    return res.status(400).json({ error: "Not placement phase" });
  }

  room.players[role].placedCards.push(card);

  if (
    room.players.attack.placedCards.length === 3 &&
    room.players.defense.placedCards.length === 3
  ) {
    room.phase = "attack";

    room.players.attack.hand = [...room.players.attack.placedCards];
    room.players.defense.hand = [...room.players.defense.placedCards];

    room.battleState = {
      step: 1,
      turn: 1, // 1=先手 2=後手
      currentRole: "attack",

      pickFrom: "self",
      forcedFace: null,

      attackHand: [...room.players.attack.hand],
      defenseHand: [...room.players.defense.hand],

      pointArea: Array(6).fill(null)
    };
  }

  res.json({ success: true });
});

/* =====================
   攻撃フェーズ（手順①〜）
===================== */
app.post("/api/attack/place/:roomId", (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: "Room not found" });

  const bs = room.battleState;
  const { role, cardIndex, face, position } = req.body;

  if (room.phase !== "attack") {
    return res.status(400).json({ error: "Not attack phase" });
  }

  if (role !== bs.currentRole) {
    return res.status(400).json({ error: "Not your turn" });
  }

  /* ===== 参照する手札 ===== */
  const sourceHand =
    bs.pickFrom === "self"
      ? (role === "attack" ? bs.attackHand : bs.defenseHand)
      : (role === "attack" ? bs.defenseHand : bs.attackHand);

  const card = sourceHand[cardIndex];
  if (!card) {
    return res.status(400).json({ error: "Invalid card" });
  }

  /* ===== 表伏せルール ===== */
  if (bs.turn === 1) {
    bs.forcedFace = face === "表" ? "伏せ" : "表";
  } else {
    if (face !== bs.forcedFace) {
      return res.status(400).json({ error: "Face rule violation" });
    }
  }

  /* ===== 位置制限（手順① 先手） ===== */
  if (bs.step === 1 && bs.turn === 1 && position !== 0) {
    return res.status(400).json({ error: "Must place at position 1" });
  }

  if (bs.pointArea[position]) {
    return res.status(400).json({ error: "Position filled" });
  }

  /* ===== 配置 ===== */
  bs.pointArea[position] = { card, face, role };
  sourceHand.splice(cardIndex, 1);

  /* ===== 手順①の進行 ===== */
  if (bs.step === 1) {
    if (bs.turn === 1) {
      // 後手へ
      bs.turn = 2;
      bs.currentRole = "defense";
      bs.pickFrom = "opponent";
    } else {
      // 手順① 完了 → 手順②
      bs.step = 2;
      bs.turn = 1;
      bs.currentRole = "defense";
      bs.pickFrom = "self";
      bs.forcedFace = null;
    }
  }

  res.json({ success: true, battleState: bs });
});

/* =====================
   サーバー起動
===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Binary Shift Server running on port ${PORT}`);
});
