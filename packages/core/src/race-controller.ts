import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { CheckpointTraceEvent } from "./types.js";

// The controller deliberately uses a tiny HTTP protocol rather than in-process
// callbacks. That is what lets application requests running in other Node
// processes participate in the same barrier.
interface ArrivalBody {
  participantId?: string;
  key?: string;
  metadata?: Record<string, unknown>;
}

interface PendingResponse {
  response: ServerResponse;
  sessionId: string;
  checkpoint: string;
}

interface CheckpointState {
  arrivals: Map<string, ArrivalBody>;
  pending: Map<string, PendingResponse>;
  released: boolean;
  aborted: boolean;
  abortReason?: string;
}

interface SessionState {
  id: string;
  token: string;
  participants: Set<string>;
  checkpoints: Map<string, CheckpointState>;
  trace: CheckpointTraceEvent[];
  waiters: Array<{
    checkpoint: string;
    count: number;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>;
}

export interface RaceSession {
  id: string;
  token: string;
  controllerUrl: string;
  participants: string[];
}

export class RaceController {
  private readonly server: Server;
  private readonly sessions = new Map<string, SessionState>();
  private address?: { host: string; port: number };
  private closed = false;

  constructor() {
    // The server starts lazily on the first session, so constructing a runner
    // never opens a listening socket by itself.
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
  }

  async start(): Promise<void> {
    if (this.address) return;
    // Port zero asks the OS for a free local port, avoiding collisions in CI.
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        const address = this.server.address();
        if (!address || typeof address === "string") {
          reject(new Error("PayProof race controller did not receive a network address"));
          return;
        }
        this.address = { host: "127.0.0.1", port: address.port };
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(0, "127.0.0.1");
    });
  }

  async registerSession(input: {
    participants: string[];
    id?: string;
    token?: string;
  }): Promise<RaceSession> {
    await this.start();
    if (this.closed) throw new Error("PayProof race controller is closed");
    if (input.participants.length === 0 || new Set(input.participants).size !== input.participants.length) {
      throw new Error("A race session requires one or more unique participants");
    }
    const id = input.id ?? randomUUID();
    const token = input.token ?? randomUUID();
    // Each session has its own token and participant allow-list. A token from
    // one test cannot be used to signal another test's barrier.
    this.sessions.set(id, {
      id,
      token,
      participants: new Set(input.participants),
      checkpoints: new Map(),
      trace: [],
      waiters: []
    });
    return {
      id,
      token,
      controllerUrl: `http://${this.address?.host}:${this.address?.port}`,
      participants: [...input.participants]
    };
  }

  async waitForArrivals(sessionId: string, checkpoint: string, count: number, timeoutMs = 10_000): Promise<void> {
    const session = this.session(sessionId);
    const state = this.checkpointState(session, checkpoint);
    if (state.arrivals.size >= count) return;

    // The promise resolves only when the HTTP arrival handler has observed the
    // required participant count; it does not release the held requests.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.waiters = session.waiters.filter((waiter) => waiter.resolve !== resolve);
        reject(new Error(`Timed out waiting for ${count} participants at checkpoint ${checkpoint}`));
      }, timeoutMs);
      session.waiters.push({ checkpoint, count, resolve, reject, timer });
    });
  }

  release(sessionId: string, checkpoint: string): void {
    const session = this.session(sessionId);
    const state = this.checkpointState(session, checkpoint);
    if (state.released) return;
    state.released = true;
    session.trace.push({
      type: "release",
      at: new Date().toISOString(),
      sessionId,
      checkpoint
    });
    // Completing the held HTTP responses is the synchronization point. The
    // application handlers resume independently after this loop.
    for (const pending of state.pending.values()) {
      this.finishResponse(pending.response, 200, { released: true });
    }
    state.pending.clear();
  }

  abort(sessionId: string, reason: string): void {
    const session = this.session(sessionId);
    // An abort must wake both current and future arrivals; otherwise a late
    // request could hang forever or be mistaken for a successful release.
    for (const [checkpoint, state] of session.checkpoints) {
      session.trace.push({ type: "abort", at: new Date().toISOString(), sessionId, checkpoint, reason });
      for (const pending of state.pending.values()) {
        this.finishResponse(pending.response, 409, { error: reason });
      }
      state.pending.clear();
      state.released = true;
      state.aborted = true;
      state.abortReason = reason;
    }
    for (const waiter of session.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(reason));
    }
    session.waiters = [];
  }

  getTrace(sessionId: string): CheckpointTraceEvent[] {
    return [...this.session(sessionId).trace];
  }

  cleanupSession(sessionId: string): void {
    if (!this.sessions.has(sessionId)) return;
    try {
      this.abort(sessionId, "session-cleanup");
    } catch {
      // Session may already have been removed during controller shutdown.
    }
    this.sessions.delete(sessionId);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Close sessions before closing the listening socket so no request remains
    // blocked on a controller that is about to disappear.
    for (const sessionId of this.sessions.keys()) this.cleanupSession(sessionId);
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private session(id: string): SessionState {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Unknown PayProof session ${id}`);
    return session;
  }

  private checkpointState(session: SessionState, name: string): CheckpointState {
    let state = session.checkpoints.get(name);
    if (!state) {
      state = { arrivals: new Map(), pending: new Map(), released: false, aborted: false };
      session.checkpoints.set(name, state);
    }
    return state;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      if (request.method !== "POST" || parts.length !== 5 || parts[0] !== "sessions" || parts[2] !== "checkpoints" || parts[4] !== "arrive") {
        this.finishResponse(response, 404, { error: "not-found" });
        return;
      }
      const sessionId = parts[1];
      const checkpoint = parts[3];
      if (!sessionId || !checkpoint) {
        this.finishResponse(response, 400, { error: "invalid-route" });
        return;
      }
      // Every arrival is authenticated and checked against the registered
      // participant set before it can affect the barrier.
      const session = this.session(sessionId);
      if (request.headers.authorization !== `Bearer ${session.token}`) {
        this.finishResponse(response, 401, { error: "unauthorized" });
        return;
      }
      const body = await this.readJson(request) as ArrivalBody;
      if (!body.participantId || !session.participants.has(body.participantId)) {
        this.finishResponse(response, 400, { error: "unknown-participant" });
        return;
      }
      const state = this.checkpointState(session, checkpoint);
      if (state.arrivals.has(body.participantId)) {
        this.finishResponse(response, 409, { error: "duplicate-arrival" });
        return;
      }
      // Arrival is recorded before the waiter is resolved, guaranteeing that
      // the orchestrator sees a complete trace when it calls release().
      state.arrivals.set(body.participantId, body);
      session.trace.push({
        type: "arrival",
        at: new Date().toISOString(),
        sessionId,
        checkpoint,
        participantId: body.participantId,
        key: body.key,
        metadata: body.metadata
      });
      this.resolveReadyWaiters(session, checkpoint, state.arrivals.size);

      if (state.aborted) {
        this.finishResponse(response, 409, { error: state.abortReason ?? "session-aborted" });
      } else if (state.released) {
        this.finishResponse(response, 200, { released: true });
      } else {
        state.pending.set(body.participantId, { response, sessionId, checkpoint });
      }
    } catch (error) {
      this.finishResponse(response, 500, { error: error instanceof Error ? error.message : "controller-error" });
    }
  }

  private resolveReadyWaiters(session: SessionState, checkpoint: string, arrivalCount: number): void {
    for (const waiter of [...session.waiters]) {
      if (waiter.checkpoint !== checkpoint || arrivalCount < waiter.count) continue;
      clearTimeout(waiter.timer);
      session.waiters = session.waiters.filter((candidate) => candidate !== waiter);
      waiter.resolve();
    }
  }

  private async readJson(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (chunks.length === 0) return {};
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }

  private finishResponse(response: ServerResponse, status: number, body: unknown): void {
    if (response.writableEnded) return;
    response.statusCode = status;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(body));
  }
}
