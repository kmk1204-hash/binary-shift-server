import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const rooms = {};
rooms[roomId] = {
  phase: "waiting",   // waiting | placement | battle | result
  round: 1,           // 1 or 2
  currentTurn: "attack",

  players: {
    attack: {
      placedCards: [],   // 配置フェーズ用（伏せ）
      score: 0
    },
    defense: {
      placedCards: [],
      score: 0
    }
  }
};

/* =====================
   ルーム作成
===================== */
app.get("/api/create-room", (req, res) => {
  const roomId = Math.random().toString(36).substring(2, 8);

  rooms[roomId] = {
    phase: "waiting",
    round: 1,
    currentTurn: "attack",
    players: {
      attack: {
        placedCards: [],
        score: 0
      },
      defense: {
        placedCards: [],
        score: 0
      }
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
    attackScore: room.players.attack.score,
    defenseScore: room.players.defense.score
  });
});
/* =====================
   フェーズ遷移
===================== */
if (
  room.players.attack.placedCards.length === 3 &&
  room.players.defense.placedCards.length === 3
) {
  room.phase = "battle";
  room.currentTurn = "attack";
}
/* =====================
   バトル終了
===================== */
if (room.round === 1) {
  room.round = 2;

  // 役割入れ替え
  const tmp = room.players.attack;
  room.players.attack = room.players.defense;
  room.players.defense = tmp;

  room.phase = "placement";
  room.currentTurn = "attack";

} else {
  room.phase = "result";
}

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

