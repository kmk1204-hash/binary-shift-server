import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const rooms = {};

/* =====================
   ユーティリティ
===================== */
function getCurrentRole(step) {
  if (step === 1 || step === 4) return "attack";
  if (step === 2 || step === 3) return "defense";
  return null;
}

function removeCard(hand, index) {
  if (index < 0 || index >= hand.length) return null;
  return hand.splice(index, 1)[0];
}

/* =====================
   ルーム作成
===================== */
app.get("/api/create-room", (req, res) => {
  const roomId = Math.random().toString(36).substring(2, 8);

  rooms[roomId] = {
    phase: "placement",

    players: {
      attack: { placedCards: [] },
      defense: { placedCards: [] }
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

  res.json({ role: "defense" });
});

/* =====================
   ルーム状態取得
===================== */
app.get("/api/room-state/:roomId", (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) {
    return res.status(404).json({ error: "Room not found" });
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

  if (room.phase !== "placement") {
    return res.status(400).json({ error: "Not placement phase" });
  }

  const { role, card } = req.body;
  room.players[role].placedCards.push(card);

  // 両者3枚ずつで battle 開始
  if (
    room.players.attack.placedCards.length === 3 &&
    room.players.defense.placedCards.length === 3
  ) {
    room.phase = "battle";

    room.battleState = {
      step: 1,               // ★ state machine 開始
      forcedFace: null,

      attackHand: [...room.players.attack.placedCards],
      defenseHand: [...room.players.defense.placedCards],

      pointArea: Array(6).fill(null)
    };
  }

  res.json({ success: true });
});

/* =====================
   Battle：state machine
===================== */
app.post("/api/battle/play/:roomId", (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: "Room not found" });

  if (room.phase !== "battle") {
    return res.status(400).json({ error: "Not battle phase" });
  }

  const state = room.battleState;
  const { role, cardIndex, face, position } = req.body;

  const currentRole = getCurrentRole(state.step);
  if (role !== currentRole) {
    return res.status(400).json({ error: "Not your turn" });
  }

  if (state.forcedFace && face !== state.forcedFace) {
    return res.status(400).json({ error: "Face is forced" });
  }

  // カード取得
  let card = null;

  if (state.step === 1 || state.step === 2) {
    card = removeCard(state.attackHand, cardIndex);
  }

  if (state.step === 3 || state.step === 4) {
    card = removeCard(state.defenseHand, cardIndex);
  }

  if (!card) {
    return res.status(400).json({ error: "Invalid card" });
  }

  // 配置
  if (state.pointArea[position]) {
    return res.status(400).json({ error: "Position occupied" });
  }

  state.pointArea[position] = {
    owner: role,
    card,
    face
  };

  /* ===== state 遷移 ===== */
  switch (state.step) {
    case 1:
      state.step = 2;
      state.forcedFace = null;
      break;

    case 2:
      state.step = 3;
      state.forcedFace = null;
      break;

    case 3:
      state.step = 4;
      state.forcedFace = face === "表" ? "伏せ" : "表";
      break;

    case 4:
      state.step = 5; // resolve
      state.forcedFace = null;
      break;
  }

  res.json({
    success: true,
    battleState: state
  });
});

/* =====================
   サーバー起動
===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Binary Shift Server running on port ${PORT}`);
});
