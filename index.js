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
      attack: { placedCards: [], hand: [] },
      defense: { placedCards: [], hand: [] }
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
  if (!room) return res.status(404).json({ error: "Room not found" });

  res.json({ success: true });
});

/* =====================
   状態取得
===================== */
app.get("/api/room-state/:roomId", (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: "Room not found" });

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

  /* ========= バリデーション ========= */
  if (room.phase !== "placement") {
    return res.status(400).json({ error: "Not placement phase" });
  }

  if (role !== "attack" && role !== "defense") {
    return res.status(400).json({ error: "Invalid role" });
  }

 if (card !== 0 && card !== 1) {
    return res.status(400).json({ error: "Invalid card" });
  }

  const player = room.players[role];

  // 3枚以上置けない
  if (player.placedCards.length >= 3) {
    return res.status(400).json({ error: "Already placed 3 cards" });
  }

  /* ========= 配置 ========= */
  player.placedCards.push(card);

  /* ========= デバッグログ ========= */
  const attackCount = room.players.attack.placedCards.length;
  const defenseCount = room.players.defense.placedCards.length;

  console.log("Placement:",
    "attack =", attackCount,
    "defense =", defenseCount
  );

  /* ========= 両者3枚で Battle開始 ========= */
  if (attackCount === 3 && defenseCount === 3) {

    console.log(">>> BATTLE START");

    room.phase = "attack";

    // hand 初期化（コピー重要）
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

  res.json({
    success: true,
    attackCount,
    defenseCount,
    phase: room.phase
  });
});
/* =====================
   Battle：配置処理（step1〜6）
===================== */
app.post("/api/attack/place/:roomId", (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: "Room not found" });
  if (room.phase !== "attack") {
    return res.status(400).json({ error: "Not attack phase" });
  }

  const bs = room.battleState;
  const { role, cardIndex, face, position } = req.body;

  /* ========= 共通ユーティリティ ========= */
  const reverseFace = f => (f === "表" ? "伏せ" : "表");

  const place = (card, owner, faceValue, pos) => {
    if (bs.pointArea[pos]) {
      throw new Error("Position already filled");
    }
    bs.pointArea[pos] = { card, owner, face: faceValue };
  };

  try {
    /* =====================
       step1：攻撃（先手）
    ===================== */
    if (bs.step === 1) {
      if (role !== "attack") throw new Error("Not your turn");
      if (position !== 0) throw new Error("Must place at leftmost");

      const card = bs.attackHand[cardIndex];
      if (!card) throw new Error("Invalid card");

      place(card, "attack", face, 0);
      bs.attackHand.splice(cardIndex, 1);

      bs.forcedFace = reverseFace(face);
      bs.currentRole = "defense";
      bs.step = 2;

      return res.json({ success: true, battleState: bs });
    }

    /* =====================
       step2：防御（攻撃残り）
    ===================== */
    if (bs.step === 2) {
      if (role !== "defense") throw new Error("Not your turn");
      if (face !== bs.forcedFace) throw new Error("Face forced");

      const card = bs.attackHand[cardIndex];
      if (!card) throw new Error("Invalid card");

      place(card, "attack", face, position);
      bs.attackHand.splice(cardIndex, 1);

      bs.forcedFace = null;
      bs.currentRole = "defense";
      bs.step = 3;

      return res.json({ success: true, battleState: bs });
    }

    /* =====================
       step3：防御（先手）
    ===================== */
    if (bs.step === 3) {
      if (role !== "defense") throw new Error("Not your turn");

      const card = bs.defenseHand[cardIndex];
      if (!card) throw new Error("Invalid card");

      place(card, "defense", face, position);
      bs.defenseHand.splice(cardIndex, 1);

      bs.forcedFace = reverseFace(face);
      bs.currentRole = "attack";
      bs.step = 4;

      return res.json({ success: true, battleState: bs });
    }

    /* =====================
       step4：攻撃（防御残り）
    ===================== */
    if (bs.step === 4) {
      if (role !== "attack") throw new Error("Not your turn");
      if (face !== bs.forcedFace) throw new Error("Face forced");

      const card = bs.defenseHand[cardIndex];
      if (!card) throw new Error("Invalid card");

      place(card, "defense", face, position);
      bs.defenseHand.splice(cardIndex, 1);

      bs.forcedFace = null;
      bs.currentRole = "attack";
      bs.step = 5;

      return res.json({ success: true, battleState: bs });
    }

    /* =====================
       step5：攻撃（最終選択）
    ===================== */
    if (bs.step === 5) {
      if (role !== "attack") throw new Error("Not your turn");

      const combined = [...bs.attackHand, ...bs.defenseHand];
      const card = combined[cardIndex];
      if (!card) throw new Error("Invalid card");

      const owner =
        bs.attackHand.includes(card) ? "attack" : "defense";

      place(card, owner, face, position);

      if (owner === "attack") {
        bs.attackHand = [];
      } else {
        bs.defenseHand = [];
      }

      bs.currentRole = "defense";
      bs.step = 6;
    }

    /* =====================
       step6：自動配置
    ===================== */
    if (bs.step === 6) {
      const remainingCard =
        bs.attackHand[0] || bs.defenseHand[0];

      const owner = bs.attackHand.length ? "attack" : "defense";
      const pos = bs.pointArea.findIndex(p => p === null);

      place(remainingCard, owner, "表", pos);

      bs.attackHand = [];
      bs.defenseHand = [];

      // ラウンド完了（次フェーズへ）
      return res.json({ success: true, battleState: bs });
    }

    res.status(400).json({ error: "Invalid step" });

  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* =====================
   サーバー起動
===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Binary Shift Server running on port ${PORT}`);
});
