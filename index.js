const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const rooms = {
  roomId: {
    players: 2,
    turn: "attack",
    phase: 1,
    board: [null, null, null, null, null, null],
    attack: {
      hand: ["0","0","0","1","1","1"]
    },
    defense: {
      hand: ["0","0","0","1","1","1"]
    }
  }
};


app.get("/", (req, res) => {
  res.send("Binary Shift Server is running");
});

app.get("/api/create-room", (req, res) => {
  const roomId = Math.random().toString(36).substring(2, 8);

  rooms[roomId] = {
    players: 1,
    roles: {
      host: "attack"
    },
    turn: "attack" // 最初は攻撃側
  };

  res.json({ roomId, role: "attack", turn: "attack" });
});


app.listen(PORT, () => {
  console.log(`サーバー起動: ${PORT}`);
});

app.get("/api/join-room/:roomId", (req, res) => {
  const { roomId } = req.params;

  if (!rooms[roomId]) {
    return res.status(404).json({ error: "Room not found" });
  }

  if (rooms[roomId].players >= 2) {
    return res.status(400).json({ error: "Room is full" });
  }

  rooms[roomId].players += 1;
  rooms[roomId].roles.guest = "defense";

  res.json({
    roomId,
    role: "defense",
    turn: rooms[roomId].turn
  });
});

app.post("/api/end-turn/:roomId", (req, res) => {
  const { roomId } = req.params;
  const { role } = req.body; // Wixから送る

  if (!rooms[roomId]) {
    return res.status(404).json({ error: "Room not found" });
  }

  // 今のターンでない人は拒否
  if (rooms[roomId].turn !== role) {
    return res.status(403).json({ error: "Not your turn" });
  }

  rooms[roomId].turn =
    rooms[roomId].turn === "attack" ? "defense" : "attack";

  res.json({ turn: rooms[roomId].turn });
});

app.post("/api/phase1/attack/:roomId", (req, res) => {
  const { roomId } = req.params;
  const { card, face } = req.body;
  const room = rooms[roomId];

  if (!room || room.turn !== "attack" || room.phase !== 1) {
    return res.status(400).json({ error: "Invalid state" });
  }

  // 手牌から削除
  const index = room.attack.hand.indexOf(card);
  if (index === -1) {
    return res.status(400).json({ error: "Card not in hand" });
  }
  room.attack.hand.splice(index, 1);

  // 位置1に配置
  room.board[0] = {
    owner: "attack",
    value: face === "face" ? card : null,
    face
  };

  room.turn = "defense";

  res.json({
    board: publicBoard(room, "attack"),
    turn: room.turn
  });
});

function publicBoard(room, role) {
  return room.board.map(cell => {
    if (!cell) return null;
    if (cell.face === "face") return cell.value;
    return cell.owner === role ? "伏せ" : "？";
  });
}




