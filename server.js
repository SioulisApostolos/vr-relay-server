// ==============================
// RELAY SERVER
// Bridges the Unity VR app and the operator dashboard.
//
// ROLES:
//   unity     → sends telemetry, receives commands
//   dashboard → sends commands, receives telemetry
//
// PROTOCOL:
//   Connect with ?role=unity or ?role=dashboard
//   Messages are JSON: { type, payload }
//
// HEARTBEAT:
//   Every HEARTBEAT_INTERVAL_MS the relay sends {"type":"ping","payload":{}}
//   to each connected client. Each client must reply with
//   {"type":"pong","payload":{}} (Unity: RelayClient.cs "ping" case in
//   HandleMessage; dashboard: handleMessage()'s ping branch). If no pong
//   is seen for HEARTBEAT_TIMEOUT_MS, the relay treats the link as dead
//   and forcibly terminates the socket. This is what catches an
//   ungraceful disconnect (crash, WiFi loss) that never sends a close
//   frame — without it, a dead Unity link could leave the dashboard
//   showing "Unity: connected" indefinitely.
//
// DEPLOY: Railway.app (see README.md)
// ==============================

const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });

const HEARTBEAT_INTERVAL_MS = 5000;
const HEARTBEAT_TIMEOUT_MS  = 12000; // ~2 missed pings before we give up

let unityClient = null;
let dashboardClient = null;
let unityLastPongAt = 0;
let dashboardLastPongAt = 0;

console.log(`[Relay] WebSocket server started on port ${PORT}`);

wss.on("connection", (ws, req) => {
  const params = new URLSearchParams(req.url.replace("/", "").replace("?", ""));
  const role = params.get("role");

  if (role === "unity") {
    unityClient = ws;
    unityLastPongAt = Date.now();
    console.log("[Relay] Unity connected");
    notifyDashboard({ type: "status", payload: { unity: true } });

    ws.on("message", (data) => {
      if (isPong(data)) {
        unityLastPongAt = Date.now();
        return; // heartbeat housekeeping — never forwarded to dashboard
      }
      // Forward telemetry from Unity → Dashboard
      if (dashboardClient && dashboardClient.readyState === 1) {
        dashboardClient.send(data.toString());
      }
    });

    ws.on("close", () => {
      console.log("[Relay] Unity disconnected");
      unityClient = null;
      notifyDashboard({ type: "status", payload: { unity: false } });
    });

  } else if (role === "dashboard") {
    dashboardClient = ws;
    dashboardLastPongAt = Date.now();
    console.log("[Relay] Dashboard connected");

    // Tell dashboard whether Unity is already connected
    ws.send(JSON.stringify({
      type: "status",
      payload: { unity: unityClient !== null && unityClient.readyState === 1 }
    }));

    ws.on("message", (data) => {
      if (isPong(data)) {
        dashboardLastPongAt = Date.now();
        return; // heartbeat housekeeping — never forwarded to Unity as a command
      }
      // Forward commands from Dashboard → Unity
      if (unityClient && unityClient.readyState === 1) {
        unityClient.send(data.toString());
      } else {
        ws.send(JSON.stringify({
          type: "error",
          payload: { message: "Unity is not connected" }
        }));
      }
    });

    ws.on("close", () => {
      console.log("[Relay] Dashboard disconnected");
      dashboardClient = null;
    });

  } else {
    console.warn("[Relay] Unknown role — closing connection");
    ws.close();
  }
});

function isPong(data) {
  try {
    return JSON.parse(data.toString()).type === "pong";
  } catch {
    return false;
  }
}

function notifyDashboard(msg) {
  if (dashboardClient && dashboardClient.readyState === 1) {
    dashboardClient.send(JSON.stringify(msg));
  }
}

// ==============================
// HEARTBEAT LOOP
// Pings whoever is connected and kills any link that's gone silent
// for longer than HEARTBEAT_TIMEOUT_MS — catches ungraceful drops
// (crash, WiFi loss) that never fire a close event on their own.
// ==============================
setInterval(() => {
  const now = Date.now();
  const ping = JSON.stringify({ type: "ping", payload: {} });

  if (unityClient && unityClient.readyState === 1) {
    if (now - unityLastPongAt > HEARTBEAT_TIMEOUT_MS) {
      console.warn("[Relay] Unity heartbeat timed out — terminating connection");
      unityClient.terminate();
    } else {
      unityClient.send(ping);
    }
  }

  if (dashboardClient && dashboardClient.readyState === 1) {
    if (now - dashboardLastPongAt > HEARTBEAT_TIMEOUT_MS) {
      console.warn("[Relay] Dashboard heartbeat timed out — terminating connection");
      dashboardClient.terminate();
    } else {
      dashboardClient.send(ping);
    }
  }
}, HEARTBEAT_INTERVAL_MS);
