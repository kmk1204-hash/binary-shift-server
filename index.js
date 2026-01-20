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

    attack: {
      step: null,          // 1 | 2 | 3
      subTurn: null,       // 1=先手 / 2=後手
      firstPlayer: null,   // "attack" | "defense"
      firstFace: null,     // "表" | "伏せ"
      pickFrom: null,      // "self" | "opponent" | "remaining"
      remainingCards: []  // 手順③用
    },

    currentActor: null,

    pointArea: [null, null, null, null, null, null],

    players: {
      attack: { placedCards: [], hand: [], score: 0 },
      defense: { placedCards: [], hand: [], score: 0 }
    }
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
    currentActor: room.currentActor,
    attack: room.attack,
    pointArea: room.pointArea
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

    room.attack.step = 1;
    room.attack.subTurn = 1;
    room.attack.firstPlayer = "attack";
    room.attack.firstFace = null;
    room.attack.pickFrom = "self";

    room.players.attack.hand = [...room.players.attack.placedCards];
    room.players.defense.hand = [...room.players.defense.placedCards];

    room.attack.remainingCards = [
      ...room.players.attack.hand,
      ...room.players.defense.hand
    ];

    room.currentActor = "attack";
  }

  res.json({ success: true });
});

/* =====================
   攻撃フェーズ
===================== */
app.post("/api/attack/place/:roomId", (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: "Room not found" });

  const { role, card, face, position } = req.body;
  const attack = room.attack;

  if (room.phase !== "attack") {
    return res.status(400).json({ error: "Not attack phase" });
  }

  const expectedActor =
    attack.subTurn === 1
      ? attack.firstPlayer
      : attack.firstPlayer === "attack" ? "defense" : "attack";

  if (role !== expectedActor) {
    return res.status(400).json({ error: "Not your turn" });
  }

  // 表伏せルール
  if (attack.subTurn === 1) {
    attack.firstFace = face;
  } else {
    if (face === attack.firstFace) {
      return res.status(400).json({ error: "Face rule violation" });
    }
  }

  if (room.pointArea[position] !== null) {
    return res.status(400).json({ error: "Position already filled" });
  }

  // 選択可能カードプール
  let pool;
  if (attack.pickFrom === "self") {
    pool = room.players[role].hand;
  } else if (attack.pickFrom === "opponent") {
    const opp = role === "attack" ? "defense" : "attack";
    pool = room.players[opp].hand;
  } else {
    pool = attack.remainingCards;
  }

  if (!pool.includes(card)) {
    return res.status(400).json({ error: "Invalid card selection" });
  }

  room.pointArea[position] = { card, face, role };

  // hand & remaining から削除
  Object.values(room.players).forEach(p => {
    const i = p.hand.indexOf(card);
    if (i !== -1) p.hand.splice(i, 1);
  });

  const rIdx = attack.remainingCards.indexOf(card);
  if (rIdx !== -1) attack.remainingCards.splice(rIdx, 1);

  // 手順進行
  if (attack.subTurn === 1) {
    attack.subTurn = 2;
  } else {
    attack.subTurn = 1;
    attack.firstFace = null;
    attack.step++;

    if (attack.step === 2) {
      attack.firstPlayer = "defense";
      attack.pickFrom = "self";
    }

    if (attack.step === 3) {
      attack.firstPlayer = "attack";
      attack.pickFrom = "remaining";
    }
  }

  // 手順③ 後手（防御側）は自動
  if (attack.step === 3 && attack.subTurn === 2) {
    const lastCard = attack.remainingCards[0];
    const lastPos = room.pointArea.findIndex(p => p === null);

    room.pointArea[lastPos] = {
      card: lastCard,
      face: attack.firstFace === "表" ? "伏せ" : "表",
      role: "defense"
    };

    attack.remainingCards = [];
    attack.step++;
  }

  if (attack.step > 3) {
    room.phase = "rewrite";
    room.currentActor = "attack";
  }

  res.json({ success: true });
});

/* =====================
   サーバー起動
===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Binary Shift Server running on port ${PORT}`);
});
