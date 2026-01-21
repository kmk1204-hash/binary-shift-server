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
      currentRole: "attack",
      forcedFace: null,

      attackHand: [...room.players.attack.hand],
      defenseHand: [...room.players.defense.hand],

      pointArea: Array(6).fill(null)
    };
  }

  res.json({ success: true });
});

/* =====================
   攻撃フェーズ（step① + step②）
===================== */
app.post("/api/attack/place/:roomId", (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: "Room not found" });

  if (room.phase !== "attack") {
    return res.status(400).json({ error: "Not attack phase" });
  }

  const bs = room.battleState;
  const { role, cardIndex, face, position } = req.body;

  if (bs.currentRole !== role) {
    return res.status(400).json({ error: "Not your turn" });
  }

  if (bs.pointArea[position]) {
    return res.status(400).json({ error: "Position already filled" });
  }

  /* =====================
     step①：攻撃側
  ===================== */
  if (bs.step === 1 && role === "attack") {
    if (position !== 0) {
      return res.status(400).json({ error: "Must place at position 1" });
    }

    const card = bs.attackHand[cardIndex];
    if (!card) return res.status(400).json({ error: "Invalid card" });

    bs.pointArea[0] = { card, face, owner: "attack" };
    bs.attackHand.splice(cardIndex, 1);

    bs.forcedFace = face === "表" ? "伏せ" : "表";
    bs.currentRole = "defense";

    return res.json({ success: true, battleState: bs });
  }

  /* =====================
     step①：防御側
  ===================== */
  if (bs.step === 1 && role === "defense") {
    if (face !== bs.forcedFace) {
      return res.status(400).json({ error: "Face rule violation" });
    }

    const card = bs.attackHand[cardIndex];
    if (!card) return res.status(400).json({ error: "Invalid card" });

    bs.pointArea[position] = { card, face, owner: "attack" };
    bs.attackHand.splice(cardIndex, 1);

    bs.step = 2;
    bs.currentRole = "defense";
    bs.forcedFace = null;

    return res.json({ success: true, battleState: bs });
  }

  /* =====================
     step②：防御側
  ===================== */
  if (bs.step === 2 && role === "defense") {
    const card = bs.defenseHand[cardIndex];
    if (!card) return res.status(400).json({ error: "Invalid card" });

    bs.pointArea[position] = { card, face: "表", owner: "defense" };
    bs.defenseHand.splice(cardIndex, 1);

    bs.currentRole = "attack";

    return res.json({ success: true, battleState: bs });
  }

  /* =====================
     step②：攻撃側
  ===================== */
  if (bs.step === 2 && role === "attack") {
    const card = bs.defenseHand[cardIndex];
    if (!card) return res.status(400).json({ error: "Invalid card" });

    bs.pointArea[position] = { card, face: "表", owner: "defense" };
    bs.defenseHand.splice(cardIndex, 1);

    // 👉 step③へ（未実装）
    bs.step = 3;
    bs.currentRole = null;

    return res.json({ success: true, battleState: bs });
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
