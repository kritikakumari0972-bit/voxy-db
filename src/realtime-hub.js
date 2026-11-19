/**
 * Project/collection fan-out hub. Clients never send database mutations over this
 * socket: writes always go through the authenticated REST API. The hub only
 * broadcasts committed change notifications.
 */
export class RealtimeHub {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/publish" && request.method === "POST") {
      const payload = await request.json();
      const sockets = this.ctx.getWebSockets();
      let delivered = 0;
      const message = JSON.stringify(payload);
      for (const socket of sockets) {
        try {
          if (socket.readyState === 1) {
            socket.send(message);
            delivered += 1;
          }
        } catch {
          try { socket.close(1011, "Broadcast failed"); } catch { /* already closed */ }
        }
      }
      return Response.json({ ok: true, delivered });
    }

    if (url.pathname === "/connect" && request.method === "GET") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("WebSocket upgrade required", { status: 426, headers: { Upgrade: "websocket" } });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ connectedAt: Date.now() });
      server.send(JSON.stringify({ type: "ready", timestamp: new Date().toISOString() }));
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("Not found", { status: 404 });
  }

  async webSocketMessage(socket, message) {
    // Client messages are deliberately limited to keep this channel read-only.
    if (message === "ping") {
      try { socket.send(JSON.stringify({ type: "pong", timestamp: new Date().toISOString() })); }
      catch { try { socket.close(1011, "Unable to respond"); } catch { /* closed */ } }
      return;
    }
    try { socket.close(1008, "VoxyDB realtime subscriptions are read-only"); } catch { /* closed */ }
  }

  async webSocketClose(socket, code, reason) {
    try { socket.close(code, reason); } catch { /* already closed */ }
  }

  async webSocketError(socket) {
    try { socket.close(1011, "Realtime connection error"); } catch { /* already closed */ }
  }
}
