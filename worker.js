import { DurableObject } from "cloudflare:workers";

const EMPTY_ROOM_TTL_MS = 30 * 60 * 1000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response("Boccia Online v2 — server commit sync OK", {
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

      const upgrade = request.headers.get("Upgrade");
      if (!upgrade || upgrade.toLowerCase() !== "websocket") {
        return new Response("WebSocket connection required", { status: 426 });
      }

      const id = env.BOCCIA_ROOMS.idFromName(roomCode);
      return env.BOCCIA_ROOMS.get(id).fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },
};

export class BocciaRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sessions = new Map();

    for (const ws of this.ctx.getWebSockets()) {
      const p = ws.deserializeAttachment();
      if (p) this.sessions.set(ws, p);
    }

    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong")
    );
  }

  async getRevision() {
    return Number((await this.ctx.storage.get("revision")) || 0);
  }

  async getState() {
    return (await this.ctx.storage.get("gameState")) || null;
  }

  async latestPacket(type = "state_sync") {
    return {
      type,
      revision: await this.getRevision(),
      state: await this.getState(),
    };
  }

  expectedSide(state) {
    const phase = state?.phase;
    if (phase === "red" || phase === "jackRed") return "red";
    if (phase === "blue" || phase === "jackBlue") return "blue";
    return null;
  }

  async fetch() {
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

    return new Response(null, { status: 101, webSocket: client });
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
      await this.ctx.storage.deleteAlarm();

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

      ws.send(
        JSON.stringify({
          type: "joined",
          playerId: player.id,
          side: player.side,
          revision: await this.getRevision(),
          state: await this.getState(),
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

    if (data.type === "state_request") {
      ws.send(JSON.stringify(await this.latestPacket("state_sync")));
      return;
    }

    if (data.type === "shot_begin") {
      const revision = await this.getRevision();
      const state = await this.getState();
      const baseRevision = Number(data.baseRevision) || 0;
      const expected = this.expectedSide(state);
      const activeShot = await this.ctx.storage.get("activeShot");

      if (
        baseRevision !== revision ||
        (expected && expected !== player.side) ||
        activeShot ||
        !data.shotId
      ) {
        ws.send(
          JSON.stringify({
            ...(await this.latestPacket("shot_rejected")),
            shotId: data.shotId || null,
          })
        );
        return;
      }

      const shot = {
        shotId: String(data.shotId),
        side: player.side,
        playerId: player.id,
        baseRevision: revision,
        kind: data.kind || null,
        startedAt: Date.now(),
      };

      await this.ctx.storage.put("activeShot", shot);

      this.broadcast(
        {
          type: "shot_begin",
          ...shot,
        },
        ws
      );
      return;
    }

    if (data.type === "frame") {
      const activeShot = await this.ctx.storage.get("activeShot");
      if (
        !activeShot ||
        activeShot.playerId !== player.id ||
        activeShot.shotId !== data.shotId ||
        Number(data.baseRevision) !== activeShot.baseRevision
      ) {
        return;
      }

      // Frames are NEVER persisted and NEVER change canonical match state.
      this.broadcast(
        {
          type: "frame",
          playerId: player.id,
          side: player.side,
          shotId: activeShot.shotId,
          baseRevision: activeShot.baseRevision,
          seq: Number(data.seq) || 0,
          frame: data.frame || null,
        },
        ws
      );
      return;
    }

    if (data.type === "commit_state") {
      const revision = await this.getRevision();
      const baseRevision = Number(data.baseRevision) || 0;
      const state = data.state;

      if (!state || baseRevision !== revision) {
        ws.send(
          JSON.stringify({
            ...(await this.latestPacket("commit_rejected")),
            shotId: data.shotId || null,
          })
        );
        return;
      }

      const activeShot = await this.ctx.storage.get("activeShot");
      if (data.shotId) {
        if (
          !activeShot ||
          activeShot.playerId !== player.id ||
          activeShot.shotId !== data.shotId ||
          activeShot.baseRevision !== revision
        ) {
          ws.send(
            JSON.stringify({
              ...(await this.latestPacket("commit_rejected")),
              shotId: data.shotId,
            })
          );
          return;
        }
      }

      const nextRevision = revision + 1;
      const committed = {
        ...state,
        version: 4,
        serverRevision: nextRevision,
      };

      await this.ctx.storage.put("gameState", committed);
      await this.ctx.storage.put("revision", nextRevision);
      if (activeShot) await this.ctx.storage.delete("activeShot");

      // This packet is the ONLY thing allowed to advance rules/turns.
      this.broadcast({
        type: "commit",
        revision: nextRevision,
        reason: data.reason || "state_update",
        shotId: data.shotId || null,
        playerId: player.id,
        side: player.side,
        state: committed,
      });
      return;
    }

    if (data.type === "restart") {
      await this.ctx.storage.delete("gameState");
      await this.ctx.storage.delete("revision");
      await this.ctx.storage.delete("activeShot");
      this.broadcast({ type: "restart", playerId: player.id });
      return;
    }
  }

  broadcastRoomState() {
    const players = [...this.sessions.values()]
      .filter((p) => p.side)
      .map((p) => ({
        id: p.id,
        side: p.side,
        ready: !!p.ready,
      }));

    this.broadcast({ type: "room_state", players });
  }

  broadcast(data, except = null) {
    const message = JSON.stringify(data);

    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(message);
      } catch {}
    }
  }

  async scheduleCleanupIfEmpty() {
    if (this.ctx.getWebSockets().length === 0) {
      await this.ctx.storage.setAlarm(Date.now() + EMPTY_ROOM_TTL_MS);
    }
  }

  async webSocketClose(ws) {
    const player = this.sessions.get(ws) || ws.deserializeAttachment();
    this.sessions.delete(ws);

    const activeShot = await this.ctx.storage.get("activeShot");
    if (player && activeShot?.playerId === player.id) {
      await this.ctx.storage.delete("activeShot");
      this.broadcast({
        ...(await this.latestPacket("shot_cancelled")),
        playerId: player.id,
        shotId: activeShot.shotId,
      });
    }

    this.broadcastRoomState();
    await this.scheduleCleanupIfEmpty();
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  async alarm() {
    if (this.ctx.getWebSockets().length === 0) {
      await this.ctx.storage.deleteAll();
      this.sessions.clear();
      return;
    }
    await this.ctx.storage.deleteAlarm();
  }
}
