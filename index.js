import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

/* =====================
   In-memory store
===================== */
const rooms = {};

/* =====================
   Utility
===================== */
const reverseFace = face => (face === "表" ? "伏せ" : "表");

/* =====================
   Create Room (簡易)
===================== */
app.post("/api/create-room", (req, res) => {
  const roomId = Math.random().toString(36).slice(2, 8);

  rooms[roomId] = {
    battleState: {
      step: 1,
      currentRole: "attack",
      forcedFace: null,

      attackHand: ["A1", "A2", "A3"],
      defenseHand: ["D1", "D2", "D3"],

      pointArea: Array(6).fill(null)
    }
  };

  res.json({ roomId });
});

/* =====================
   Get Room State
===================== */
app.get("/api/room-state/:roomId", (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: "room not found" });
  res.json(room);
});

/* =====================
   Place Card (STATE MACHINE)
===================== */
app.post("/api/attack/place/:roomId", (req, res) => {
  const { roomId } = req.params;
  const { role, cardIndex, face, position } = req.body;

  const room = rooms[roomId];
  if (!room) return res.status(404).json({ error: "room not found" });

  const bs = room.battleState;

  /* ---------- 共通バリデーション ---------- */
  if (role !== bs.currentRole) {
    return res.status(400).json({ error: "not your turn" });
  }

  if (bs.forcedFace && face !== bs.forcedFace) {
    return res.status(400).json({ error: "face is forced" });
  }

  if (bs.pointArea[position]) {
    return res.status(400).json({ error: "position occupied" });
  }

  /* =====================
     STEP STATE MACHINE
  ===================== */
  let card;

  switch (bs.step) {
    /* ---------- step1 攻撃① ---------- */
    case 1: {
      if (role !== "attack") return res.status(400).json({ error: "invalid role" });
      if (position !== 0) return res.status(400).json({ error: "position must be 0" });

      card = bs.attackHand.splice(cardIndex, 1)[0];
      bs.pointArea[0] = { card, face, owner: "attack" };

      bs.forcedFace = reverseFace(face);
      bs.currentRole = "defense";
      bs.step = 2;
      break;
    }

    /* ---------- step2 防御①（攻撃の残り） ---------- */
    case 2: {
      if (role !== "defense") return res.status(400).json({ error: "invalid role" });

      card = bs.attackHand.splice(cardIndex, 1)[0];
      bs.pointArea[position] = { card, face, owner: "attack" };

      bs.forcedFace = null;
      bs.currentRole = "defense";
      bs.step = 3;
      break;
    }

    /* ---------- step3 防御② ---------- */
    case 3: {
      if (role !== "defense") return res.status(400).json({ error: "invalid role" });

      card = bs.defenseHand.splice(cardIndex, 1)[0];
      bs.pointArea[position] = { card, face, owner: "defense" };

      bs.forcedFace = reverseFace(face);
      bs.currentRole = "attack";
      bs.step = 4;
      break;
    }

    /* ---------- step4 攻撃②（防御の残り） ---------- */
    case 4: {
      if (role !== "attack") return res.status(400).json({ error: "invalid role" });

      card = bs.defenseHand.splice(cardIndex, 1)[0];
      bs.pointArea[position] = { card, face, owner: "defense" };

      bs.forcedFace = null;
      bs.currentRole = "attack";
      bs.step = 5;
      break;
    }

    /* ---------- step5 攻撃③（残り2枚から自由） ---------- */
    case 5: {
      if (role !== "attack") return res.status(400).json({ error: "invalid role" });

      const pool = [...bs.attackHand, ...bs.defenseHand];
      if (cardIndex < 0 || cardIndex >= pool.length) {
        return res.status(400).json({ error: "invalid card index" });
      }

      card = pool[cardIndex];
      if (bs.attackHand.includes(card)) {
        bs.attackHand.splice(bs.attackHand.indexOf(card), 1);
      } else {
        bs.defenseHand.splice(bs.defenseHand.indexOf(card), 1);
      }

      bs.pointArea[position] = {
        card,
        face,
        owner: bs.attackHand.includes(card) ? "attack" : "defense"
      };

      bs.currentRole = "defense";
      bs.step = 6;
      break;
    }

    /* ---------- step6 防御③（自動） ---------- */
    case 6: {
      if (role !== "defense") return res.status(400).json({ error: "invalid role" });

      const lastCard =
        bs.attackHand[0] ?? bs.defenseHand[0];

      const lastOwner = bs.attackHand.length ? "attack" : "defense";
      const lastPos = bs.pointArea.findIndex(p => !p);

      bs.pointArea[lastPos] = {
        card: lastCard,
        face: "表",
        owner: lastOwner
      };

      bs.attackHand = [];
      bs.defenseHand = [];
      bs.step = "END";
      break;
    }

    default:
      return res.status(400).json({ error: "battle already finished" });
  }

  res.json({ success: true, battleState: bs });
});

/* =====================
   Server Start
===================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Battle server running on", PORT);
});
