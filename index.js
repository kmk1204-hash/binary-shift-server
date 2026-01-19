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
      step: null,        // 1 | 2 | 3
      subTurn: null,     // 1=先手 / 2=後手
      firstPlayer: null, // "attack" | "defense"
      firstFace: null    // "face" | "back"
    },

    currentActor: null,

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
    round: room.round,
    currentActor: room.currentActor,
    attack: room.attack,
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

  // 両者3枚で攻撃フェーズへ
  if (
    room.players.attack.placedCards.length === 3 &&
    room.players.defense.placedCards.length === 3
  ) {
    room.phase = "attack";
    room.attack.step = 1;
    room.attack.subTurn = 1;
    room.attack.firstPlayer = "attack";
    room.attack.firstFace = null;
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

  const { role, card, face, position } = req.body;
  const attack = room.attack;

  if (room.phase !== "attack") {
    return res.status(400).json({ error: "Not attack phase" });
  }

  // 誰のターンか
  const expectedActor =
    attack.subTurn === 1
      ? attack.firstPlayer
      : attack.firstPlayer === "attack"
        ? "defense"
        : "attack";

  if (role !== expectedActor) {
    return res.status(400).json({ error: "Not your turn" });
  }

  // 表／伏せルール
  if (attack.subTurn === 1) {
    attack.firstFace = face;
  } else {
    if (face === attack.firstFace) {
      return res.status(400).json({ error: "Face rule violation" });
    }
  }

  // 位置チェック
  if (room.pointArea[position] !== null) {
    return res.status(400).json({ error: "Position already filled" });
  }

  // 配置
  room.pointArea[position] = { card, face, role };

  // 手札から削除
  const hand = room.players[role].hand;
  const idx = hand.indexOf(card);
  if (idx !== -1) hand.splice(idx, 1);

  // 手順進行
  if (attack.subTurn === 1) {
    attack.subTurn = 2;
  } else {
    attack.subTurn = 1;
    attack.firstFace = null;
    attack.step++;

    if (attack.step === 2) attack.firstPlayer = "defense";
    if (attack.step === 3) attack.firstPlayer = "attack";
  }

  // 攻撃フェーズ終了
 if (attack.step > 3) {
  room.phase = "rewrite";
  room.rewrite = {
    attackUsed: false,
    defenseUsed: false,
    lockedIndexes: []
  };
  room.currentActor = "attack"; // 攻撃側から読み替え
}


rewrite: {
  attackUsed: false,
  defenseUsed: false,
  lockedIndexes: [] // 既に読み替えられた開始位置
}

function getBinaryArray(room) {
  return room.pointArea.map(p => p.card);
}

app.post("/api/rewrite/:roomId", (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: "Room not found" });

  if (room.phase !== "rewrite") {
    return res.status(400).json({ error: "Not rewrite phase" });
  }

  const { role, startIndex } = req.body; 
  // startIndex = 0〜3（3連続の開始位置）

  const binary = getBinaryArray(room);
  const rewrite = room.rewrite;

  // 使用済みチェック
  if (role === "attack" && rewrite.attackUsed) {
    return res.status(400).json({ error: "Attack already used rewrite" });
  }
  if (role === "defense" && rewrite.defenseUsed) {
    return res.status(400).json({ error: "Defense already used rewrite" });
  }

  // ロックチェック
  if (rewrite.lockedIndexes.includes(startIndex)) {
    return res.status(400).json({ error: "Already rewritten area" });
  }

  const target = binary.slice(startIndex, startIndex + 3).join("");

  // ルール判定
  if (role === "attack" && target !== "000") {
    return res.status(400).json({ error: "Attack can rewrite only 000" });
  }
  if (role === "defense" && target !== "111") {
    return res.status(400).json({ error: "Defense can rewrite only 111" });
  }

  // 書き換え
  const newValue = role === "attack" ? "1" : "0";
  for (let i = startIndex; i < startIndex + 3; i++) {
    room.pointArea[i].card = newValue;
  }

  rewrite.lockedIndexes.push(startIndex);

  if (role === "attack") rewrite.attackUsed = true;
  if (role === "defense") rewrite.defenseUsed = true;

  // ターン交代 or 終了
  room.currentActor =
    role === "attack" ? "defense" : null;

  // 両者終了で次へ
  if (rewrite.attackUsed && rewrite.defenseUsed) {
    room.phase = "result"; // ここでは一旦 result
    room.currentActor = null;
  }

  res.json({
    success: true,
    binary: getBinaryArray(room)
  });
});

/* =====================
   サーバー起動
===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Binary Shift Server running on port ${PORT}`);
});

