import { DurableObject } from "cloudflare:workers";

const EMPTY_ROOM_TTL_MS = 30 * 60 * 1000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response("Boccia SERVER-TRUTH — OK", {
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
      const player = ws.deserializeAttachment();
      if (player) this.sessions.set(ws, player);
    }

    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong")
    );
  }

  async fetch() {
    await this.ctx.storage.deleteAlarm();

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);

    const player = {
      id: crypto.randomUUID(),
      clientKey: null,
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

  async getRevision() {
    return Number((await this.ctx.storage.get("revision")) || 0);
  }

  async getState() {
    return (await this.ctx.storage.get("gameState")) || null;
  }

  connectedPlayers() {
    return [...this.sessions.values()]
      .filter((p) => p.side)
      .map((p) => ({
        id: p.id,
        side: p.side,
        ready: !!p.ready,
      }));
  }

  async snapshotPayload(type = "snapshot", extra = {}) {
    return {
      type,
      revision: await this.getRevision(),
      state: await this.getState(),
      players: this.connectedPlayers(),
      ...extra,
    };
  }

  expectedSide(state) {
    const phase = state?.phase;
    if (phase === "jackRed" || phase === "red") return "red";
    if (phase === "jackBlue" || phase === "blue") return "blue";
    return null;
  }

  async getSeats() {
    return (
      (await this.ctx.storage.get("seats")) || {
        red: null,
        blue: null,
      }
    );
  }

  async saveSeats(seats) {
    await this.ctx.storage.put("seats", seats);
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
        clientKey: null,
        side: null,
        ready: false,
      };

    if (data.type === "join") {
      await this.ctx.storage.deleteAlarm();

      const clientKey = String(data.clientKey || player.id).slice(0, 160);
      const seats = await this.getSeats();

      let side = null;
      if (seats.red?.clientKey === clientKey) side = "red";
      if (seats.blue?.clientKey === clientKey) side = "blue";

      // Replace a stale socket from the same browser/tab.
      for (const [otherWs, other] of this.sessions.entries()) {
        if (otherWs === ws) continue;
        if (other.clientKey && other.clientKey === clientKey) {
          this.sessions.delete(otherWs);
          try {
            otherWs.close(1012, "reconnected");
          } catch {}
        }
      }

      if (!side) {
        if (!seats.red) {
          side = "red";
          seats.red = { clientKey, ready: false };
        } else if (!seats.blue) {
          side = "blue";
          seats.blue = { clientKey, ready: false };
        } else {
          ws.send(JSON.stringify({ type: "room_full" }));
          return;
        }
      }

      const seat = seats[side] || { clientKey, ready: false };
      player = {
        id: player.id || crypto.randomUUID(),
        clientKey,
        side,
        ready: !!seat.ready,
      };

      seats[side] = {
        clientKey,
        ready: player.ready,
      };

      await this.saveSeats(seats);
      ws.serializeAttachment(player);
      this.sessions.set(ws, player);

      ws.send(
        JSON.stringify({
          type: "joined",
          playerId: player.id,
          side: player.side,
          ready: player.ready,
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

      const seats = await this.getSeats();
      if (seats[player.side]?.clientKey === player.clientKey) {
        seats[player.side].ready = player.ready;
        await this.saveSeats(seats);
      }

      this.broadcastRoomState();
      return;
    }

    if (data.type === "sync_request") {
      ws.send(JSON.stringify(await this.snapshotPayload()));
      return;
    }

    if (data.type === "start_match" && data.state && data.startId) {
      const currentState = await this.getState();
      const currentRevision = await this.getRevision();

      // If another retry/client already started it, return the canonical state.
      if (currentState) {
        ws.send(
          JSON.stringify(
            await this.snapshotPayload("snapshot", {
              commitId: data.startId,
            })
          )
        );
        return;
      }

      const players = this.connectedPlayers();
      const red = players.find((p) => p.side === "red");
      const blue = players.find((p) => p.side === "blue");

      if (
        player.side !== "red" ||
        !red?.ready ||
        !blue?.ready
      ) {
        ws.send(
          JSON.stringify({
            type: "start_rejected",
            revision: currentRevision,
            state: currentState,
          })
        );
        return;
      }

      const revision = 1;
      const committedState = {
        ...data.state,
        revision,
      };

      await this.ctx.storage.put("revision", revision);
      await this.ctx.storage.put("gameState", committedState);
      await this.ctx.storage.put("lastCommitId", String(data.startId));

      // Broadcast is fast path. Polling is the fallback path.
      this.broadcast({
        type: "state_saved",
        revision,
        commitId: data.startId,
        playerId: player.id,
        side: player.side,
        state: committedState,
      });
      return;
    }

    if (data.type === "save_state" && data.state && data.commitId) {
      const currentRevision = await this.getRevision();
      const currentState = await this.getState();
      const lastCommitId =
        (await this.ctx.storage.get("lastCommitId")) || null;

      // Idempotent retry: same save can arrive 100 times and still applies once.
      if (lastCommitId === data.commitId) {
        ws.send(
          JSON.stringify({
            type: "state_saved",
            revision: currentRevision,
            commitId: data.commitId,
            playerId: player.id,
            side: player.side,
            state: currentState,
          })
        );
        return;
      }

      const baseRevision = Number(data.baseRevision) || 0;

      if (!currentState || baseRevision !== currentRevision) {
        ws.send(
          JSON.stringify({
            type: "state_conflict",
            revision: currentRevision,
            state: currentState,
          })
        );
        return;
      }

      // Only the side whose turn exists in the last canonical state can write
      // the next canonical state. This also covers Jack and end transitions.
      const expected = this.expectedSide(currentState);
      if (expected && expected !== player.side) {
        ws.send(
          JSON.stringify({
            type: "state_conflict",
            revision: currentRevision,
            state: currentState,
          })
        );
        return;
      }

      const nextRevision = currentRevision + 1;
      const committedState = {
        ...data.state,
        revision: nextRevision,
      };

      await this.ctx.storage.put("revision", nextRevision);
      await this.ctx.storage.put("gameState", committedState);
      await this.ctx.storage.put("lastCommitId", String(data.commitId));

      // The same canonical state goes back to BOTH clients, including sender.
      this.broadcast({
        type: "state_saved",
        revision: nextRevision,
        commitId: data.commitId,
        playerId: player.id,
        side: player.side,
        state: committedState,
      });
      return;
    }

    if (data.type === "restart") {
      await this.ctx.storage.delete("revision");
      await this.ctx.storage.delete("gameState");
      await this.ctx.storage.delete("lastCommitId");

      const seats = await this.getSeats();
      if (seats.red) seats.red.ready = false;
      if (seats.blue) seats.blue.ready = false;
      await this.saveSeats(seats);

      for (const [socket, p] of this.sessions.entries()) {
        p.ready = false;
        socket.serializeAttachment(p);
        this.sessions.set(socket, p);
      }

      this.broadcast({
        type: "restart",
        playerId: player.id,
      });
      this.broadcastRoomState();
      return;
    }

    if (data.type === "leave") {
      const seats = await this.getSeats();
      if (
        player.side &&
        seats[player.side]?.clientKey === player.clientKey
      ) {
        seats[player.side] = null;
        await this.saveSeats(seats);
      }

      this.sessions.delete(ws);
      this.broadcastRoomState();
      try {
        ws.close(1000, "leave");
      } catch {}

      await this.scheduleCleanupIfEmpty();
      return;
    }
  }

  broadcastRoomState() {
    this.broadcast({
      type: "room_state",
      players: this.connectedPlayers(),
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

  async scheduleCleanupIfEmpty() {
    if (this.ctx.getWebSockets().length === 0) {
      await this.ctx.storage.setAlarm(Date.now() + EMPTY_ROOM_TTL_MS);
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

  async alarm() {
    if (this.ctx.getWebSockets().length === 0) {
      await this.ctx.storage.deleteAll();
      this.sessions.clear();
      return;
    }

    await this.ctx.storage.deleteAlarm();
  }
}
