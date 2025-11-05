// server.js
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const fs = require("fs");

const app = express();
app.use(cors());
app.get("/", (req, res) => res.send("Bookmarklet Chat Server Running ✅"));

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: ["*", "null"], methods: ["GET", "POST"], credentials: true },
});

// ===== In-memory data =====
const messages = [];                // message history (in-memory)
const banned = {};                  // fingerprint -> { nickname, timeBanned }
const loggedInAdmins = {};          // socket.id -> true if logged in

// Admin config
const ADMIN_NAMES = ["Jonny_Boi", "AceLemming", "Owen"];
const ADMIN_PASSWORD = "BuB123";

// Midnight reset (PDT) - clears bans at LA midnight
function scheduleMidnightReset() {
  const now = new Date();
  // compute next midnight in America/Los_Angeles
  const tz = "America/Los_Angeles";
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const parts = fmt.formatToParts(now).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const year = parseInt(parts.year, 10);
  const month = parseInt(parts.month, 10);
  const day = parseInt(parts.day, 10);

  // create a Date for tomorrow 00:00:00 in LA by using Date.UTC for the LA date then adjusting offsets
  const tomorrow = new Date(Date.UTC(year, month - 1, day + 1, 0, 0, 0));
  // compute ms until that instant in real UTC
  const msUntil = tomorrow.getTime() - now.getTime();
  // schedule
  setTimeout(() => {
    // clear bans at LA midnight
    for (const k of Object.keys(banned)) delete banned[k];
    console.log("Bans cleared at midnight (LA).");
    // reschedule
    scheduleMidnightReset();
  }, msUntil + 500); // slight buffer
}
scheduleMidnightReset();

// Utility: send private system message to a socket
function sendPrivateSystem(socket, text) {
  socket.emit("system-private", { text, time: new Date().toLocaleTimeString() });
}

// Utility: append public system announcement (safe)
function broadcastSystem(text) {
  io.emit("system", { text, time: new Date().toLocaleTimeString() });
}

io.on("connection", (socket) => {
  const { nickname, fingerprint } = socket.handshake.auth || {};

  if (!nickname || !fingerprint) {
    // missing identity -> disconnect quietly
    socket.disconnect(true);
    return;
  }

  // If fingerprint banned, immediately disconnect with a force-close event
  const banEntry = banned[fingerprint];
  if (banEntry) {
    socket.emit("force-close", "⛔ You have been banned until midnight (PDT).");
    socket.disconnect(true);
    return;
  }

  // Send message history to this socket
  socket.emit("message-history", messages);

  // --- Message handling ---
  socket.on("message", (data) => {
    const textRaw = (data && typeof data.text === "string") ? data.text : "";
    const text = textRaw.trim();

    if (!text) return; // ignore empty

    const lower = text.toLowerCase();

    // ---------- Intercept /login: NEVER broadcast this ----------
    if (lower.startsWith("/login ")) {
      // Always handle privately and DO NOT append to messages or broadcast
      const parts = text.split(" ");
      const provided = parts[1] || "";
      if (ADMIN_NAMES.includes(nickname) && provided === ADMIN_PASSWORD) {
        loggedInAdmins[socket.id] = true;
        sendPrivateSystem(socket, "✅ Logged in as admin.");
      } else {
        // failed login — private notice only, do NOT echo password anywhere
        sendPrivateSystem(socket, "❌ Login failed (wrong password or unauthorized nickname).");
      }
      return;
    }

    // ---------- Intercept /deleteall: NEVER broadcast the command text ----------
    if (lower.startsWith("/deleteall")) {
      // If admin and logged in -> clear messages; else just privately notify "no permission"
      const isAdmin = !!loggedInAdmins[socket.id] && ADMIN_NAMES.includes(nickname);
      if (isAdmin) {
        messages.length = 0;
        // notify all clients to clear UI
        io.emit("clearchat");
        // safe public notice (no password or raw command)
        broadcastSystem(`${nickname} cleared all messages.`);
        // private confirmation
        sendPrivateSystem(socket, "✅ Messages cleared.");
      } else {
        // do not broadcast the raw command or any portion of it
        sendPrivateSystem(socket, "❌ You do not have permission to clear messages.");
      }
      return;
    }

    // ---------- Admin-only commands: /ban and /unban ----------
    if (text.startsWith("/ban ") || text.startsWith("/unban ")) {
      const parts = text.split(" ");
      const cmd = parts[0];
      const arg = parts[1];

      // Check login+name
      const isAdmin = !!loggedInAdmins[socket.id] && ADMIN_NAMES.includes(nickname);

      if (!isAdmin) {
        // NOT logged in as admin -> do NOT broadcast the raw command; send private notice instead
        sendPrivateSystem(socket, "❌ You must /login as an admin to use admin commands.");
        return;
      }

      // isAdmin === true -> handle command securely (do NOT broadcast raw command)
      if (cmd === "/ban") {
        if (!arg) { sendPrivateSystem(socket, "⚠️ Usage: /ban <fingerprint>"); return; }
        banned[arg] = { nickname: arg, time: Date.now() }; // store minimal info
        sendPrivateSystem(socket, `✅ Fingerprint ${arg} banned until midnight (PDT).`);
        broadcastSystem(`${arg} was banned by ${nickname}.`);
        // disconnect any connected sockets having that fingerprint
        for (const [id, s] of io.of("/").sockets) {
          try {
            const fp = s.handshake?.auth?.fingerprint;
            if (fp === arg) {
              s.emit("force-close", "⛔ You have been banned until midnight (PDT).");
              s.disconnect(true);
            }
          } catch (e) {}
        }
        return;
      }

      if (cmd === "/unban") {
        if (!arg) { sendPrivateSystem(socket, "⚠️ Usage: /unban <fingerprint|nickname>"); return; }
        // allow unban by fingerprint key directly, or by nickname lookup
        let fpKey = null;
        if (banned[arg]) fpKey = arg;
        else {
          // try to find fingerprint by nickname in banned entries
          for (const [k, info] of Object.entries(banned)) {
            if (info && info.nickname === arg) { fpKey = k; break; }
          }
        }
        if (!fpKey) {
          sendPrivateSystem(socket, `⚠️ No ban found for ${arg}.`);
          return;
        }
        delete banned[fpKey];
        sendPrivateSystem(socket, `✅ Unbanned ${arg}.`);
        broadcastSystem(`${arg} was unbanned by ${nickname}.`);
        return;
      }
    }

    // ---------- All other slash commands (unknown) ----------
    if (text.startsWith("/")) {
      // Unknown command — DO NOT broadcast the original text (could contain secrets).
      // Instead, respond privately that the command is unknown or requires login.
      sendPrivateSystem(socket, "❓ Unknown command or you need to /login as admin to run this command.");
      return;
    }

    // ---------- Normal chat message ----------
    const message = {
      nickname,
      text,
      time: new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
    };
    messages.push(message);
    // keep reasonable history
    if (messages.length > 1000) messages.shift();

    // broadcast to all
    io.emit("message", message);
  });

  // Clean up on disconnect
  socket.on("disconnect", () => {
    delete loggedInAdmins[socket.id];
  });
});

// Start server
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
