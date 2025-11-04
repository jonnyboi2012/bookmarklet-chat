// server.js
import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import fs from "fs";

const app = express();
const server = http.createServer(app);

// Allow bookmarklets ("null" origin) and all browsers
app.use(cors({
  origin: ["*", "null"],
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"],
  credentials: true
}));

// Socket.IO server with same CORS config
const io = new Server(server, {
  cors: {
    origin: ["*", "null"],
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
    credentials: true
  }
});

const PORT = 8080; // <- your preferred port

// Persistent storage
const DATA_FILE = "./bans.txt";
let banned = {};
if (fs.existsSync(DATA_FILE)) {
  try { banned = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch { banned = {}; }
}

function saveBans() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(banned, null, 2));
}

// Reset bans at midnight PDT
function scheduleReset() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  const ms = next - now;
  setTimeout(() => {
    banned = {};
    saveBans();
    console.log("Bans reset at midnight PDT");
    scheduleReset();
  }, ms);
}
scheduleReset();

// Chat state
let messages = [];
let clients = {};

const ADMINS = ["Jonny_Boi", "AceLemming", "Owen"];
const ADMIN_PASSWORD = "BuB123";
const DELETE_ALL_PASSWORD = "Lyyq831028*";

// Root endpoint
app.get("/", (req, res) => res.send("Bookmarklet Chat Server Running ✅"));

// Socket.IO connection
io.on("connection", socket => {
  const { nickname, fingerprint } = socket.handshake.auth || {};
  clients[socket.id] = { nickname, fingerprint };

  if (banned[fingerprint]) {
    socket.emit("force-close", "You have been banned until midnight.");
    socket.disconnect(true);
    return;
  }

  socket.emit("message-history", messages);
  socket.broadcast.emit("system", { text: `${nickname} joined`, time: new Date().toLocaleTimeString() });

  socket.on("message", msg => {
    const text = msg.text.trim();

    // Admin commands
    if (ADMINS.includes(nickname)) {
      if (text.startsWith("/kick ")) {
        const targetNick = text.split(" ")[1];
        const target = Object.entries(clients).find(([id, c]) => c.nickname === targetNick);
        if (target) {
          io.to(target[0]).emit("force-close", "You have been kicked.");
          io.sockets.sockets.get(target[0])?.disconnect(true);
          io.emit("system", { text: `${targetNick} was kicked by ${nickname}`, time: new Date().toLocaleTimeString() });
        }
        return;
      }

      if (text.startsWith("/ban ")) {
        const targetNick = text.split(" ")[1];
        const target = Object.entries(clients).find(([id, c]) => c.nickname === targetNick);
        if (target) {
          const fp = target[1].fingerprint;
          banned[fp] = { nickname: targetNick, time: Date.now() };
          saveBans();
          io.to(target[0]).emit("force-close", "You have been banned until midnight.");
          io.sockets.sockets.get(target[0])?.disconnect(true);
          io.emit("system", { text: `${targetNick} was banned by ${nickname}`, time: new Date().toLocaleTimeString() });
        }
        return;
      }

      if (text.startsWith("/unban ")) {
        const arg = text.split(" ")[1];
        let fpKey = null;
        for (const [fp, info] of Object.entries(banned)) {
          if (fp === arg || info.nickname === arg) {
            fpKey = fp;
            break;
          }
        }
        if (fpKey) {
          const unbannedNick = banned[fpKey].nickname;
          delete banned[fpKey];
          saveBans();
          io.emit("system", { text: `${unbannedNick} was unbanned by ${nickname}`, time: new Date().toLocaleTimeString() });
        } else {
          socket.emit("system", { text: `No ban found for ${arg}`, time: new Date().toLocaleTimeString() });
        }
        return;
      }

      if (text === `/deleteall ${DELETE_ALL_PASSWORD}`) {
        messages = [];
        io.emit("message-history", []);
        io.emit("system", { text: `💥 All messages deleted by ${nickname}`, time: new Date().toLocaleTimeString() });
        return;
      }
    }

    // Normal message
    const m = {
      nickname,
      text,
      time: new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    };
    messages.push(m);
    if (messages.length > 200) messages.shift();
    io.emit("message", m);
  });

  socket.on("disconnect", () => {
    const n = clients[socket.id]?.nickname;
    delete clients[socket.id];
    io.emit("system", { text: `${n} left`, time: new Date().toLocaleTimeString() });
  });
});

server.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
