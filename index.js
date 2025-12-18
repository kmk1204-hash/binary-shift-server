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
    players: 1,
    turn: "attack"
  };

  res.json({
    roomId,
    role: "attack",
    turn: "attack"
  });
});

/* =====================
   ルーム参加
===================== */
app.get("/api/join-room/:roomId", (req, res) => {
  const room = rooms[req.params.roomId];

  if (!room || room.players >= 2) {
    return res.status(400).json({ error: "Room not available" });
  }

  room.players = 2;

  res.json({
    role: "defense",
    turn: room.turn
  });
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
    currentTurn: room.turn
  });
});

/* =====================
   ターン終了
===================== */
app.post("/api/end-turn/:roomId", (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) {
    return res.status(404).json({ error: "Room not found" });
  }

  room.turn = room.turn === "attack" ? "defense" : "attack";

  res.json({
    currentTurn: room.turn
  });
});

/* =====================
   サーバー起動
===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
