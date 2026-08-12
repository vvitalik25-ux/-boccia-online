import { DurableObject } from "cloudflare:workers";

const EMPTY_ROOM_TTL_MS = 30 * 60 * 1000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response("Boccia Online — server OK", {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    if (url.pathname.startsWith("/room/")) {
      const roomCode = url.pathname
        .split("/")[2]
        ?.toUpperCase()
        .replace(/[^A-Z0-9]/g, "");

      if (!roomCode || roomCode.length < 4 || roomCode.length > 8) {
        return new Response("Invalid room code", { status: 400 });
      }

      if (!env.BOCCIA_ROOMS) {
        return new Response("BOCCIA_ROOMS binding is not configured", {
          status: 500,
        });
      }

      const upgrade = request.headers.get("Upgrade");
      if (!upgrade || upgrade.toLowerCase() !== "websocket") {
        return new Response("WebSocket connection required", { status: 426 });
      }

      const id = env.BOCCIA_ROOMS.idFromName(roomCode);
      const room = env.BOCCIA_ROOMS.get(id);
      return room.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },
};

export class BocciaRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sessions = new Map();

    for (const ws of this.ctx.getWebSockets()) {
      const player = ws.deserializeAttachment();
      if (player) this.sessions.set(ws, player);
    }

    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong")
    );
  }

  async fetch() {
    // A player is connecting/reconnecting, so keep this room alive.
    await this.ctx.storage.deleteAlarm();

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);

    const player = {
      id: crypto.randomUUID(),
      side: null,
      ready: false,
    };

    server.serializeAttachment(player);
    this.sessions.set(server, player);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(ws, message) {
    let data;

    try {
      data = JSON.parse(message);
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    let player =
      this.sessions.get(ws) ||
      ws.deserializeAttachment() || {
        id: crypto.randomUUID(),
        side: null,
        ready: false,
      };

    if (data.type === "join") {
      const occupied = new Set(
        [...this.sessions.values()]
          .filter((p) => p.id !== player.id && p.side)
          .map((p) => p.side)
      );

      if (!player.side) {
        if (!occupied.has("red")) player.side = "red";
        else if (!occupied.has("blue")) player.side = "blue";
        else {
          ws.send(JSON.stringify({ type: "room_full" }));
          return;
        }
      }

      player.ready = false;
      ws.serializeAttachment(player);
      this.sessions.set(ws, player);

      const savedState = await this.ctx.storage.get("gameState");

      ws.send(
        JSON.stringify({
          type: "joined",
          playerId: player.id,
          side: player.side,
          state: savedState || null,
        })
      );

      this.broadcastRoomState();
      return;
    }

    if (!player.side) {
      ws.send(JSON.stringify({ type: "error", message: "Join room first" }));
      return;
    }

    if (data.type === "ready") {
      player.ready = !!data.ready;
      ws.serializeAttachment(player);
      this.sessions.set(ws, player);
      this.broadcastRoomState();
      return;
    }

    if (data.type === "shot_result" && data.state) {
      await this.ctx.storage.put("gameState", data.state);
    }

    if (
      ["throw", "shot_result", "sync_state", "restart", "decline", "game_start"]
        .includes(data.type)
    ) {
      this.broadcast({
        ...data,
        side: player.side,
        playerId: player.id,
      });
      return;
    }

    if (data.type === "state_request") {
      const savedState = await this.ctx.storage.get("gameState");
      ws.send(
        JSON.stringify({
          type: "state_reply",
          state: savedState || null,
        })
      );
    }
  }

  async scheduleCleanupIfEmpty() {
    if (this.ctx.getWebSockets().length === 0) {
      await this.ctx.storage.setAlarm(Date.now() + EMPTY_ROOM_TTL_MS);
    }
  }

  async alarm() {
    // If nobody came back within 30 minutes, erase the whole room state.
    if (this.ctx.getWebSockets().length === 0) {
      await this.ctx.storage.deleteAll();
      this.sessions.clear();
      return;
    }

    await this.ctx.storage.deleteAlarm();
  }

  broadcastRoomState() {
    const players = [...this.sessions.values()]
      .filter((p) => p.side)
      .map((p) => ({
        id: p.id,
        side: p.side,
        ready: !!p.ready,
      }));

    this.broadcast({
      type: "room_state",
      players,
    });
  }

  broadcast(data) {
    const message = JSON.stringify(data);

    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message);
      } catch {}
    }
  }

  async webSocketClose(ws) {
    this.sessions.delete(ws);
    this.broadcastRoomState();
    await this.scheduleCleanupIfEmpty();
  }

  async webSocketError(ws) {
    this.sessions.delete(ws);
    this.broadcastRoomState();
    await this.scheduleCleanupIfEmpty();
  }
}
