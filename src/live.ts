/**
 * Instant delivery.
 *
 * One Durable Object, InboxHub, holds every open browser socket. The email
 * handler pokes it after storing a message and it tells each socket what
 * arrived; the page then refreshes at once instead of on its next poll.
 * Sockets use the hibernation API, so an idle hub costs nothing, and the
 * "ping"/"pong" auto-response keeps connections alive without waking it.
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";

export interface LiveEvent {
  type: "new";
  address: string;
  id: string;
  code: string | null;
  at: number;
}

export class InboxHub extends DurableObject<Env> {
  /** The most recent event, kept in memory so tests can look at it. */
  last: LiveEvent | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /** Accepts one browser's WebSocket. The Worker has already checked the session and origin. */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** Sends an event to every open socket; returns how many received it. */
  async broadcast(event: LiveEvent): Promise<number> {
    this.last = event;
    const payload = JSON.stringify(event);
    let sent = 0;
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(payload); sent++; } catch { /* a socket mid-close */ }
    }
    return sent;
  }

  async webSocketMessage(): Promise<void> {
    // Nothing is expected from the browser; "ping" is answered automatically.
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try { ws.close(code, reason); } catch { /* already gone */ }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try { ws.close(1011, "error"); } catch { /* already gone */ }
  }
}

/** The single hub every request talks to. */
export function hubStub(env: Env) {
  return env.INBOX_HUB.get(env.INBOX_HUB.idFromName("hub"));
}

/** Tells open browsers about an arrival. Never lets a hub problem fail the ingest. */
export async function pokeHub(env: Env, event: LiveEvent): Promise<void> {
  try {
    await hubStub(env).broadcast(event);
  } catch (err) {
    console.warn("live hub unreachable", err);
  }
}
