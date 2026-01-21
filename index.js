import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const rooms = {};

/* =====================
   ルーム作成（攻撃側）
===================== */
app.get("/api/create-room", (req, res) => {
  const roomId = Math.random().toString(36).substring(2, 8);

  rooms[roomId] = {
    phase: "placement",

    // placement専用
    currentActor: "attack",

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
    },

    // battle用
    battleState: null
  };

  res.json({ roomId });
});

/* =====================
   ルーム参加（防御側）
===================== */
app.get("/api/join-room/:roomId", (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) {
    return res.status(404).json({ error: "Room not found" });
  }

  res.json({ success: true });
});

/* =====================
   ルーム状態取得
===================== */
app.get("/api/room-state/:roomId", (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) {
    return res.status(404).json({ error: "Room not found" });
  }

  // placement 中
  if (room.phase === "placement") {
    return res.json({
      phase: room.phase,
      currentActor: room.currentActor
    });
  }

  // battle 中
  if (room.phase === "attack") {
    return res.json({
      phase: room.phase,
      battleState: room.battleState
    });
  }

  res.json({ phase: room.phase });
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

  // 手番交代
  room.currentActor = role === "attack" ? "defense" : "attack";

  // 両者3枚ずつ置いたら battle 開始
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

    // placement 専用なので不要
    delete room.currentActor;
  }

  res.json({ success: true });
});

/* =====================
   Battle フェーズ
===================== */
app.post("/api/attack/place/:roomId", (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: "Room not found" });

  if (room.phase !== "attack") {
    return res.status(400).json({ error: "Not battle phase" });
  }

  const bs = room.battleState;
  const { role, cardIndex, face, position } = req.body;

  if (bs.currentRole !== role) {
    return res.status(400).json({ error: "Not your turn" });
  }

  // 対象手札決定
  let hand;
  if (bs.step === 1 || bs.step === 2 || bs.step === 5) {
    hand = role === "attack" ? bs.attackHand : bs.attackHand;
  } else {
    hand = role === "attack" ? bs.defenseHand : bs.defenseHand;
  }

  const card = hand[cardIndex];
  if (!card) {
    return res.status(400).json({ error: "Invalid card" });
  }

  if (bs.pointArea[position]) {
    return res.status(400).json({ error: "Position occupied" });
  }

  bs.pointArea[position] = {
    card,
    face,
    owner: role
  };

  hand.splice(cardIndex, 1);

  // 表伏せ強制
  bs.forcedFace = face === "表" ? "伏せ" : "表";

  // step 遷移
  const transitions = {
    1: { nextStep: 2, nextRole: "defense" },
    2: { nextStep: 3, nextRole: "defense" },
    3: { nextStep: 4, nextRole: "attack" },
    4: { nextStep: 5, nextRole: "attack" },
    5: { nextStep: 6, nextRole: "defense" }
  };

  const t = transitions[bs.step];
  if (t) {
    bs.step = t.nextStep;
    bs.currentRole = t.nextRole;
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
