// server.js
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors());
app.get("/", (req, res) => res.send("Bookmarklet Chat Server Running ✅"));

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// ===== Memory storage =====
const messages = [];
const banned = {}; // fingerprint -> nickname
const loggedInAdmins = {}; // socket.id -> true if logged in

const ADMIN_NAMES = ["Jonny_Boi", "AceLemming", "Owen"];
const ADMIN_PASSWORD = "BuB123";

// Midnight reset (PDT)
setInterval(() => {
  const now = new Date();
  if (now.getHours() === 0 && now.getMinutes() === 0) {
    Object.keys(banned).forEach((fp) => delete banned[fp]);
    console.log("Midnight reset complete, bans cleared.");
  }
}, 60 * 1000);

io.on("connection", (socket) => {
  const { nickname, fingerprint } = socket.handshake.auth || {};

  // Check ban
  if (banned[fingerprint]) {
    socket.emit("banned");
    socket.disconnect(true);
    return;
  }

  // Send message history
  socket.emit("loadMessages", messages);

  socket.on("message", (data) => {
    const msgText = data.text.trim();
    const lower = msgText.toLowerCase();

    // --- /login ---
    if (lower.startsWith("/login")) {
      const parts = msgText.split(" ");
      const password = parts[1];
      if (
        ADMIN_NAMES.includes(nickname) &&
        password === ADMIN_PASSWORD
      ) {
        loggedInAdmins[socket.id] = true;
        socket.emit("system", "✅ Logged in as admin.");
      } else {
        socket.emit("system", "❌ Incorrect password or not an admin name.");
      }
      return;
    }

    // --- if this is an admin command ---
    if (msgText.startsWith("/")) {
      if (!loggedInAdmins[socket.id]) {
        // Not logged in → treat as normal message
        const msg = {
          nickname,
          text: msgText,
          time: new Date().toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
          }),
        };
        messages.push(msg);
        io.emit("message", msg);
        return;
      }

      const [cmd, arg] = msgText.split(" ");
      if (cmd === "/ban" && arg) {
        banned[arg] = nickname;
        io.emit("system", `${arg} was banned by ${nickname}`);
        return;
      }
      if (cmd === "/unban" && arg) {
        delete banned[arg];
        io.emit("system", `${arg} was unbanned by ${nickname}`);
        return;
      }
      if (cmd === "/deleteall") {
        messages.length = 0;
        io.emit("clearchat");
        return;
      }

      socket.emit("system", "Unknown admin command.");
      return;
    }

    // --- normal chat message ---
    const msg = {
      nickname,
      text: msgText,
      time: new Date().toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
      }),
    };
    messages.push(msg);
    io.emit("message", msg);
  });

  socket.on("disconnect", () => {
    delete loggedInAdmins[socket.id];
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));
