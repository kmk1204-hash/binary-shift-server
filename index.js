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
    phase: "waiting", // waiting | placement | battle | result
    round: 1,
    currentTurn: "attack",
    players: {
      attack: { placedCards: [], score: 0 },
      defense: { placedCards: [], score: 0 }
    }
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

  room.phase = "placement";
  room.currentTurn = "attack";

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
    round: room.round,
    currentTurn: room.currentTurn,
    attackPlaced: room.players.attack.placedCards.length,
    defensePlaced: room.players.defense.placedCards.length
  });
});

/* =====================
   配置フェーズ：カード配置
===================== */
app.post("/api/phase1/place/:roomId", (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) {
    return res.status(404).json({ error: "Room not found" });
  }

  const { role, card } = req.body;

  if (room.currentTurn !== role) {
    return res.status(400).json({ error: "Not your turn" });
  }

  room.players[role].placedCards.push(card);

  // ターン交代
  room.currentTurn = role === "attack" ? "defense" : "attack";

  // 両者3枚でバトルへ
  if (
    room.players.attack.placedCards.length === 3 &&
    room.players.defense.placedCards.length === 3
  ) {
    room.phase = "battle";
    room.currentTurn = "attack";
  }

  res.json({ success: true });
});

/* =====================
   サーバー起動
===================== */
app.listen(3000, () => {
  console.log("Binary Shift Server running");
});
