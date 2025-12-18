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
    turn: "attack",
    phase: 1,
    board: [null, null, null, null, null, null],
    attack: {
      hand: ["0", "0", "0", "1", "1", "1"]
    },
    defense: {
      hand: ["0", "0", "0", "1", "1", "1"]
    }
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

app.post("/api/phase1/attack/:roomId", (req, res) => {
  const { roomId } = req.params;
  const { card, face } = req.body;

  const room = rooms[roomId];
  if (!room) {
    return res.status(404).json({ error: "Room not found" });
  }

  if (room.turn !== "attack" || room.phase !== 1) {
    return res.status(400).json({ error: "Not attack phase 1" });
  }

  // 手牌チェック
  const index = room.attack.hand.indexOf(card);
  if (index === -1) {
    return res.status(400).json({ error: "Card not in hand" });
  }

  // 手牌から削除
  room.attack.hand.splice(index, 1);

  // 左端（位置0）に配置
  room.board[0] = {
    owner: "attack",
    value: face === "face" ? card : null,
    face
  };

  // 防御側ターンへ
  room.turn = "defense";

  res.json({
    board: getPublicBoard(room, "attack"),
    turn: room.turn
  });
});

function getPublicBoard(room, role) {
  return room.board.map(cell => {
    if (!cell) return null;

    if (cell.face === "face") {
      return cell.value;
    }

    return cell.owner === role ? "伏せ" : "？";
  });
}
