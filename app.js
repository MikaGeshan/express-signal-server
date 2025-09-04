require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const https = require("https");

const app = express();

const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",")
  : ["*"];
app.use(cors({ origin: allowedOrigins, credentials: true }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
  },
});

app.get("/ice", (req, res) => {
  const options = {
    host: "global.xirsys.net",
    path: "/_turn/AI-Documentation",
    method: "PUT",
    headers: {
      Authorization:
        "Basic " +
        Buffer.from(
          process.env.XIRSYS_USER + ":" + process.env.XIRSYS_SECRET
        ).toString("base64"),
      "Content-Type": "application/json",
    },
  };

  const request = https.request(options, (response) => {
    let data = "";
    response.on("data", (chunk) => (data += chunk));
    response.on("end", () => {
      try {
        const parsed = JSON.parse(data);
        res.json(parsed.v.iceServers);
      } catch (err) {
        console.error("Xirsys parse error:", err.message);
        res.status(500).json({ error: "Invalid Xirsys response" });
      }
    });
  });

  request.on("error", (err) => {
    console.error("Xirsys request error:", err.message);
    res.status(500).json({ error: err.message });
  });

  request.write(JSON.stringify({ format: "urls" }));
  request.end();
});

const userToSocket = {};
const socketToUser = {};
const socketToRole = {};
const roleToSockets = {
  admin: new Set(),
};
const pendingSignals = {};
const callerToAdmin = {};

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.on("register", (payload) => {
    console.log("Raw register payload:", JSON.stringify(payload));

    const id = payload?.id || payload?.userId || payload?.user?.id;
    const role = payload?.role || payload?.user?.role;

    if (!id || !role) {
      console.warn(
        `Invalid registration payload from socket ${socket.id}:`,
        JSON.stringify(payload)
      );
      return;
    }

    userToSocket[id] = socket.id;
    socketToUser[socket.id] = id;
    socketToRole[socket.id] = role;

    if (role === "admin") {
      roleToSockets.admin.add(socket.id);
    }

    console.log(`Registered user with socket ${socket.id}:`, { id, role });

    if (pendingSignals[id]) {
      console.log(
        `Delivering ${pendingSignals[id].length} pending signals to ${id}`
      );
      pendingSignals[id].forEach(({ data, fromUserId }) => {
        socket.emit("signal", { data, fromUserId });
      });
      delete pendingSignals[id];
    }
  });

  socket.on("signal", ({ targetUserId, data, fromUserId }) => {
    const socketId = socket.id;
    const resolvedFromUserId = fromUserId || socketToUser[socketId];

    if (!resolvedFromUserId) {
      console.warn(
        `Signal received from unknown socket ${socketId}. No user ID found.`
      );
      return;
    }

    if (!targetUserId) {
      console.log(
        `Broadcasting signal from caller ${resolvedFromUserId} to all admins`
      );

      const signalData = { data, fromUserId: resolvedFromUserId };

      if (callerToAdmin[resolvedFromUserId]) {
        console.log(
          `Caller ${resolvedFromUserId} already assigned to an admin.`
        );
        return;
      }

      if (!pendingSignals[resolvedFromUserId]) {
        const sendToAdmins = () => {
          if (callerToAdmin[resolvedFromUserId]) {
            clearInterval(pendingSignals[resolvedFromUserId].interval);
            delete pendingSignals[resolvedFromUserId];
            return;
          }

          if (roleToSockets.admin.size === 0) {
            console.log(
              `No admins connected. Will retry sending signal from ${resolvedFromUserId}`
            );
            return;
          }

          roleToSockets.admin.forEach((adminSocketId) => {
            const adminSocket = io.sockets.sockets.get(adminSocketId);
            if (adminSocket) {
              adminSocket.emit("signal", signalData);
              console.log(
                `Sent signal to admin socket ${adminSocketId} from ${resolvedFromUserId}`
              );
            }
          });
        };

        sendToAdmins();
        const interval = setInterval(sendToAdmins, 3000);

        pendingSignals[resolvedFromUserId] = { interval };
      }

      return;
    }

    const adminSocketId = socketId;

    if (
      callerToAdmin[targetUserId] &&
      callerToAdmin[targetUserId] !== adminSocketId
    ) {
      console.warn(
        `Admin ${adminSocketId} tried to respond to caller ${targetUserId}, but already handled by ${callerToAdmin[targetUserId]}`
      );
      return;
    }

    callerToAdmin[targetUserId] = adminSocketId;

    if (pendingSignals[targetUserId]?.interval) {
      clearInterval(pendingSignals[targetUserId].interval);
      delete pendingSignals[targetUserId];
    }

    const targetSocketId = userToSocket[targetUserId];
    if (targetSocketId && io.sockets.sockets.get(targetSocketId)) {
      io.to(targetSocketId).emit("signal", {
        data,
        fromUserId: resolvedFromUserId,
      });
      console.log(
        `Sent signal from admin ${adminSocketId} to caller ${targetUserId}`
      );
    } else {
      if (!pendingSignals[targetUserId]) pendingSignals[targetUserId] = [];
      pendingSignals[targetUserId].push({
        data,
        fromUserId: resolvedFromUserId,
      });
      console.log(`Stored signal for offline caller ${targetUserId}`);
    }
  });

  socket.on("disconnect", () => {
    const userId = socketToUser[socket.id];
    const role = socketToRole[socket.id];

    console.log(
      `Client disconnected: ${socket.id} (${role || "unknown role"})`
    );

    if (userId) {
      delete userToSocket[userId];
      Object.keys(callerToAdmin).forEach((caller) => {
        if (callerToAdmin[caller] === socket.id) {
          delete callerToAdmin[caller];
        }
      });
    }

    if (role === "admin") {
      roleToSockets.admin.delete(socket.id);
    }

    delete socketToUser[socket.id];
    delete socketToRole[socket.id];
  });
});

// --- Railway PORT binding ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
