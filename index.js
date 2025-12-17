const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const rooms = {};

app.get("/", (req, res) => {
  res.send("Binary Shift Server is running");
});

app.get("/api/create-room", (req, res) => {
  const roomId = Math.random().toString(36).substring(2, 8);
  rooms[roomId] = { players: 1 };
  res.json({ roomId });
});

app.listen(PORT, () => {
  console.log(`サーバー起動: ${PORT}`);
});

app.get("/api/join-room/:roomId", (req, res) => {
  const { roomId } = req.params;

  if (!rooms[roomId]) {
    return res.status(404).json({ error: "Room not found" });
  }

  rooms[roomId].players += 1;
  res.json({ success: true, roomId });
});
