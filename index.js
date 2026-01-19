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
    phase: "waiting", // waiting | placement | attack | rewrite | result
    round: 1,

    attackStep: null, // 1 | 2 | 3
    subTurn: null,    // 1 | 2
    currentActor: null, // attack | defense
    faceRule: null,     // face | back

    pointArea: [null, null, null, null, null, null],

    players: {
      attack: {
        placedCards: [],
        hand: [],
        score: 0
      },
      defense: {
        placedCards: [],
        hand: [],
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
  room.currentActor = "attack";

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
    attackStep: room.attackStep,
    subTurn: room.subTurn,
    currentActor: room.currentActor,
    pointArea: room.pointArea,
    attackHand: room.players.attack.hand.length,
    defenseHand: room.players.defense.hand.length
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

  if (room.currentActor !== role) {
    return res.status(400).json({ error: "Not your turn" });
  }

  room.players[role].placedCards.push(card);

  room.currentActor = role === "attack" ? "defense" : "attack";

  if (
    room.players.attack.placedCards.length === 3 &&
    room.players.defense.placedCards.length === 3
  ) {
    room.phase = "attack";
    room.attackStep = 1;
    room.subTurn = 1;
    room.currentActor = "attack";

    room.players.attack.hand = [...room.players.attack.placedCards];
    room.players.defense.hand = [...room.players.defense.placedCards];
  }

  res.json({ success: true });
});

/* =====================
   攻撃フェーズ：カード配置
===================== */
app.post("/api/attack/place/:roomId", (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: "Room not found" });

  const { actor, source, cardIndex, position, face } = req.body;

  if (room.phase !== "attack") {
    return res.status(400).json({ error: "Not attack phase" });
  }

  if (room.currentActor !== actor) {
    return res.status(400).json({ error: "Not your turn" });
  }

  let card;
  if (source === "own") {
    card = room.players[actor].hand.splice(cardIndex, 1)[0];
  } else if (source === "opponent") {
    const opponent = actor === "attack" ? "defense" : "attack";
    card = room.players[opponent].hand.splice(cardIndex, 1)[0];
  } else if (source === "field") {
    card = room.pointArea.find(c => c && c.face === "back");
  } else {
    return res.status(400).json({ error: "Invalid source" });
  }

  const finalFace =
    room.faceRule === null ? face :
    room.faceRule === "face" ? "back" : "face";

  room.pointArea[position - 1] = {
    value: card,
    face: finalFace
  };

  /* ===== フェーズ進行 ===== */
  if (room.subTurn === 1) {
    room.faceRule = finalFace;
    room.subTurn = 2;
    room.currentActor = actor === "attack" ? "defense" : "attack";
  } else {
    room.faceRule = null;
    room.subTurn = 1;

    if (room.attackStep < 3) {
      room.attackStep += 1;
      room.currentActor =
        room.attackStep === 2 ? "defense" : "attack";
    } else {
      room.phase = "rewrite";
      room.currentActor = null;
    }
  }

  res.json({ success: true });
});

/* =====================
   ターン終了（保険用）
===================== */
app.post("/api/end-turn/:roomId", (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: "Room not found" });

  room.currentActor =
    room.currentActor === "attack" ? "defense" : "attack";

  res.json({ currentActor: room.currentActor });
});

/* =====================
   サーバー起動
===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Binary Shift Server running on port ${PORT}`);
});
