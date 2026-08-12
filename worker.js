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

  expectedSide(state) {
    const phase = state?.phase;
    if (phase === "jackRed" || phase === "red") return "red";
    if (phase === "jackBlue" || phase === "blue") return "blue";
    return null;
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
          revision: Number((await this.ctx.storage.get("turnRevision")) || 0),
          activeThrow: (await this.ctx.storage.get("activeThrow")) || null,
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

    if (data.type === "game_start" && data.state) {
      // Only red starts a fresh room. Duplicate starts are harmless.
      const existingState = await this.ctx.storage.get("gameState");
      const existingRevision = Number(
        (await this.ctx.storage.get("turnRevision")) || 0
      );

      if (existingState) {
        ws.send(JSON.stringify({
          type: "state_reply",
          revision: existingRevision,
          state: existingState,
          activeThrow: (await this.ctx.storage.get("activeThrow")) || null,
        }));
        return;
      }

      if (player.side !== "red") return;

      const initialRevision = 1;
      const initialState = {
        ...data.state,
        turnRevision: initialRevision,
      };

      await this.ctx.storage.put("gameState", initialState);
      await this.ctx.storage.put("turnRevision", initialRevision);
      await this.ctx.storage.delete("activeThrow");
      await this.ctx.storage.delete("lastCommitId");

      this.broadcast({
        type: "game_start",
        state: initialState,
        revision: initialRevision,
        side: player.side,
        playerId: player.id,
      });
      return;
    }

    if (data.type === "throw") {
      const currentRevision = Number(
        (await this.ctx.storage.get("turnRevision")) || 0
      );
      const currentState =
        (await this.ctx.storage.get("gameState")) || null;
      const activeThrow =
        (await this.ctx.storage.get("activeThrow")) || null;
      const expected = this.expectedSide(currentState);
      const baseRevision = Number(data.baseRevision) || 0;

      if (
        !data.throwId ||
        activeThrow ||
        baseRevision !== currentRevision ||
        (expected && expected !== player.side)
      ) {
        ws.send(JSON.stringify({
          type: "throw_rejected",
          revision: currentRevision,
          state: currentState,
        }));
        return;
      }

      const throwInfo = {
        throwId: String(data.throwId),
        playerId: player.id,
        side: player.side,
        baseRevision: currentRevision,
        kind: data.kind || null,
        startedAt: Date.now(),
      };

      await this.ctx.storage.put("activeThrow", throwInfo);

      // The opponent receives only "a throw is happening". No coordinates.
      this.broadcast({
        type: "throw",
        throwId: throwInfo.throwId,
        baseRevision: currentRevision,
        kind: throwInfo.kind,
        side: player.side,
        playerId: player.id,
      }, ws);
      return;
    }

    if (data.type === "turn_commit" && data.state && data.commitId) {
      const currentRevision = Number(
        (await this.ctx.storage.get("turnRevision")) || 0
      );
      const currentState =
        (await this.ctx.storage.get("gameState")) || null;
      const activeThrow =
        (await this.ctx.storage.get("activeThrow")) || null;
      const lastCommitId =
        (await this.ctx.storage.get("lastCommitId")) || null;

      // Idempotency: the same commit may be retried any number of times.
      if (lastCommitId === data.commitId) {
        ws.send(JSON.stringify({
          type: "turn_committed",
          revision: currentRevision,
          commitId: data.commitId,
          reason: data.reason || "shot_result",
          playerId: player.id,
          side: player.side,
          state: currentState,
        }));
        return;
      }

      const baseRevision = Number(data.baseRevision) || 0;
      if (baseRevision !== currentRevision) {
        ws.send(JSON.stringify({
          type: "turn_rejected",
          revision: currentRevision,
          commitId: data.commitId,
          state: currentState,
        }));
        return;
      }

      const reason = data.reason || "shot_result";

      if (reason === "shot_result") {
        if (
          !activeThrow ||
          activeThrow.playerId !== player.id ||
          activeThrow.throwId !== data.throwId ||
          activeThrow.baseRevision !== currentRevision
        ) {
          ws.send(JSON.stringify({
            type: "turn_rejected",
            revision: currentRevision,
            commitId: data.commitId,
            state: currentState,
          }));
          return;
        }
      } else if (reason === "decline") {
        const expected = this.expectedSide(currentState);
        if (activeThrow || (expected && expected !== player.side)) {
          ws.send(JSON.stringify({
            type: "turn_rejected",
            revision: currentRevision,
            commitId: data.commitId,
            state: currentState,
          }));
          return;
        }
      } else if (reason === "state_transition") {
        // Automatic end / tiebreak transition. There must be no live throw.
        if (activeThrow) {
          ws.send(JSON.stringify({
            type: "turn_rejected",
            revision: currentRevision,
            commitId: data.commitId,
            state: currentState,
          }));
          return;
        }
      }

      const nextRevision = currentRevision + 1;
      const committedState = {
        ...data.state,
        turnRevision: nextRevision,
      };

      await this.ctx.storage.put("gameState", committedState);
      await this.ctx.storage.put("turnRevision", nextRevision);
      await this.ctx.storage.put("lastCommitId", data.commitId);
      if (activeThrow) await this.ctx.storage.delete("activeThrow");

      // This is the ONLY packet that advances a turn.
      this.broadcast({
        type: "turn_committed",
        revision: nextRevision,
        commitId: data.commitId,
        reason,
        playerId: player.id,
        side: player.side,
        state: committedState,
      });
      return;
    }

    if (data.type === "restart") {
      await this.ctx.storage.delete("gameState");
      await this.ctx.storage.delete("turnRevision");
      await this.ctx.storage.delete("lastCommitId");
      await this.ctx.storage.delete("activeThrow");
      this.broadcast({
        type: "restart",
        playerId: player.id,
        side: player.side,
      });
      return;
    }

    if (data.type === "state_request") {
      const savedState = await this.ctx.storage.get("gameState");
      ws.send(
        JSON.stringify({
          type: "state_reply",
          revision: Number((await this.ctx.storage.get("turnRevision")) || 0),
          activeThrow: (await this.ctx.storage.get("activeThrow")) || null,
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
    const player = this.sessions.get(ws) || ws.deserializeAttachment();
    this.sessions.delete(ws);

    const activeThrow =
      (await this.ctx.storage.get("activeThrow")) || null;

    if (player && activeThrow?.playerId === player.id) {
      await this.ctx.storage.delete("activeThrow");
      const state = (await this.ctx.storage.get("gameState")) || null;
      const revision = Number(
        (await this.ctx.storage.get("turnRevision")) || 0
      );

      this.broadcast({
        type: "throw_cancelled",
        revision,
        state,
        playerId: player.id,
      });
    }

    this.broadcastRoomState();
    await this.scheduleCleanupIfEmpty();
  }

  async webSocketError(ws) {
    this.sessions.delete(ws);
    this.broadcastRoomState();
    await this.scheduleCleanupIfEmpty();
  }
}
