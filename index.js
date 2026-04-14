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

  if (player.placedCards.length >= 3) {
    return res.status(400).json({ error: "Already placed 3 cards" });
  }

  player.placedCards.push(card);

  const attackCount = room.players.attack.placedCards.length;
  const defenseCount = room.players.defense.placedCards.length;

  if (attackCount === 3 && defenseCount === 3) {
    room.phase = "attack";

    room.players.attack.hand = [...room.players.attack.placedCards];
    room.players.defense.hand = [...room.players.defense.placedCards];

    room.battleState = {
      step: 1,
      currentRole: "attack",
      forcedFace: null,

      attackHand: room.players.attack.hand.map(c => ({
        value: c,
        owner: "attack"
      })),

      defenseHand: room.players.defense.hand.map(c => ({
        value: c,
        owner: "defense"
      })),

      pointArea: Array(6).fill(null),

      // ★ 勝敗用追加
      result: null,
      attackReplaced: false,
      defenseReplaced: false
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
   Battle：配置処理
===================== */
app.post("/api/attack/place/:roomId", (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: "Room not found" });
  if (room.phase !== "attack") {
    return res.status(400).json({ error: "Not attack phase" });
  }

  const bs = room.battleState;
  const { role, cardIndex, face, position } = req.body;

  const reverseFace = f => (f === "表" ? "伏せ" : "表");

  const place = (card, owner, faceValue, pos) => {
    if (bs.pointArea[pos]) throw new Error("Position already filled");

    bs.pointArea[pos] = {
      card,
      owner,
      face: faceValue,
      placedBy: bs.currentRole
    };
  };

  try {
    if (bs.step === 1) {
      if (role !== "attack") throw new Error("Not your turn");
      if (position !== 0) throw new Error("Must place at leftmost");

      const cardObj = bs.attackHand[cardIndex];
      if (!cardObj) throw new Error("Invalid card");

      place(cardObj.value, "attack", face, 0);
      bs.attackHand.splice(cardIndex, 1);

      bs.forcedFace = reverseFace(face);
      bs.currentRole = "defense";
      bs.step = 2;

      return res.json({ success: true, battleState: bs });
    }

    if (bs.step === 2) {
      if (role !== "defense") throw new Error("Not your turn");
      if (face !== bs.forcedFace) throw new Error("Face forced");

      const cardObj = bs.attackHand[cardIndex];
      if (!cardObj) throw new Error("Invalid card");

      place(cardObj.value, "attack", face, position);
      bs.attackHand.splice(cardIndex, 1);

      bs.forcedFace = null;
      bs.step = 3;

      return res.json({ success: true, battleState: bs });
    }

    if (bs.step === 3) {
      if (role !== "defense") throw new Error("Not your turn");

      const cardObj = bs.defenseHand[cardIndex];
      if (!cardObj) throw new Error("Invalid card");

      place(cardObj.value, "defense", face, position);
      bs.defenseHand.splice(cardIndex, 1);

      bs.forcedFace = reverseFace(face);
      bs.currentRole = "attack";
      bs.step = 4;

      return res.json({ success: true, battleState: bs });
    }

    if (bs.step === 4) {
      if (role !== "attack") throw new Error("Not your turn");
      if (face !== bs.forcedFace) throw new Error("Face forced");

      const cardObj = bs.defenseHand[cardIndex];
      if (!cardObj) throw new Error("Invalid card");

      place(cardObj.value, "defense", face, position);
      bs.defenseHand.splice(cardIndex, 1);

      bs.forcedFace = null;
      bs.step = 5;

      return res.json({ success: true, battleState: bs });
    }

    if (bs.step === 5) {
      if (role !== "attack") throw new Error("Not your turn");

      const combined = [...bs.attackHand, ...bs.defenseHand];
      const cardObj = combined[cardIndex];
      if (!cardObj) throw new Error("Invalid card");

      place(cardObj.value, cardObj.owner, face, position);

      if (cardObj.owner === "attack") {
        bs.attackHand = bs.attackHand.filter(c => c !== cardObj);
      } else {
        bs.defenseHand = bs.defenseHand.filter(c => c !== cardObj);
      }

      bs.currentRole = "defense";
      bs.step = 6;
    }

    if (bs.step === 6) {
      const remaining =
        bs.attackHand[0] || bs.defenseHand[0];

      if (!remaining) throw new Error("No remaining card");

      const pos = bs.pointArea.findIndex(p => p === null);

      place(remaining.value, remaining.owner, "表", pos);

      bs.attackHand = [];
      bs.defenseHand = [];

      /* ===== ★勝敗ロジック追加 ===== */

      const binary = bs.pointArea.map(p => String(p.card)).join("");

      bs.result = {
        originalBinary: binary,
        finalBinary: binary,
        attackScore: parseInt(binary, 2)
      };

      return res.json({ success: true, battleState: bs });
    }

    res.status(400).json({ error: "Invalid step" });

  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* =====================
   読み替えAPI
===================== */
app.post("/api/battle/replace/:roomId", (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: "Room not found" });

  const { role } = req.body;
  const bs = room.battleState;

  if (!bs.result) {
    return res.status(400).json({ error: "No result yet" });
  }

  let str = bs.result.finalBinary;

  if (role === "attack") {
    if (bs.attackReplaced) {
      return res.status(400).json({ error: "Already used" });
    }

    const i = str.indexOf("000");
    if (i !== -1) {
      str = str.slice(0, i) + "111" + str.slice(i + 3);
      bs.attackReplaced = true;
    }
  }

  if (role === "defense") {
    if (bs.defenseReplaced) {
      return res.status(400).json({ error: "Already used" });
    }

    const i = str.indexOf("111");
    if (i !== -1) {
      str = str.slice(0, i) + "000" + str.slice(i + 3);
      bs.defenseReplaced = true;
    }
  }

  bs.result.finalBinary = str;
  bs.result.attackScore = parseInt(str, 2);

  res.json({ success: true, result: bs.result });
});

/* =====================
   サーバー起動
===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Binary Shift Server running on port ${PORT}`);
});
