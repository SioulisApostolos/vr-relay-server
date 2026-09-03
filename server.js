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
// DEPLOY: Railway.app (see README.md)
// ==============================

const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });

let unityClient = null;
let dashboardClient = null;

console.log(`[Relay] WebSocket server started on port ${PORT}`);

wss.on("connection", (ws, req) => {
  const params = new URLSearchParams(req.url.replace("/", "").replace("?", ""));
  const role = params.get("role");

  if (role === "unity") {
    unityClient = ws;
    console.log("[Relay] Unity connected");
    notifyDashboard({ type: "status", payload: { unity: true } });

    ws.on("message", (data) => {
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
    console.log("[Relay] Dashboard connected");

    // Tell dashboard whether Unity is already connected
    ws.send(JSON.stringify({
      type: "status",
      payload: { unity: unityClient !== null && unityClient.readyState === 1 }
    }));

    ws.on("message", (data) => {
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

function notifyDashboard(msg) {
  if (dashboardClient && dashboardClient.readyState === 1) {
    dashboardClient.send(JSON.stringify(msg));
  }
}
