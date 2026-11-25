import { AsyncLocalStorage } from "node:async_hooks";
import { fetch } from "undici";

/**
 * Per-request connection details. The participant ID is deliberately part of
 * the context so two concurrent webhook requests in one Node process can be
 * held independently by the controller.
 */
export interface CheckpointContext {
  enabled: boolean;
  controllerUrl: string;
  sessionId: string;
  participantId: string;
  token: string;
  timeoutMs?: number;
}

export interface CheckpointOptions {
  key?: string;
  metadata?: Record<string, string | number | boolean>;
  signal?: AbortSignal;
}

/** Configuration used by an application to opt into test instrumentation. */
export interface CheckpointConfig extends Partial<CheckpointContext> {
  enabled?: boolean;
  allowRequestHeaders?: boolean;
  defaultTimeoutMs?: number;
}

const contextStorage = new AsyncLocalStorage<CheckpointContext>();
let globalConfig: CheckpointContext | undefined;
let requestHeadersEnabled = false;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Configure a process-wide checkpoint context. Normal applications should not
 * call this with `enabled: true`; the request middleware is safer because it
 * scopes controller credentials to the individual test request.
 */
export function configureCheckpoint(config: CheckpointConfig): void {
  requestHeadersEnabled = config.allowRequestHeaders === true;
  if (config.enabled !== true) {
    globalConfig = undefined;
    return;
  }

  if (!config.controllerUrl || !config.sessionId || !config.participantId || !config.token) {
    throw new Error("Enabled BachsProof checkpoints require controllerUrl, sessionId, participantId, and token");
  }

  globalConfig = {
    enabled: true,
    controllerUrl: config.controllerUrl,
    sessionId: config.sessionId,
    participantId: config.participantId,
    token: config.token,
    timeoutMs: config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
  };
}

/** Remove all process-wide instrumentation state after a test or shutdown. */
export function disableCheckpoints(): void {
  globalConfig = undefined;
  requestHeadersEnabled = false;
}

/** Fast diagnostic used by hosts that want to know whether a barrier is active. */
export function isCheckpointEnabled(): boolean {
  return contextStorage.getStore()?.enabled === true || globalConfig?.enabled === true;
}

/**
 * Run asynchronous application code inside one request-scoped checkpoint
 * context. AsyncLocalStorage preserves the context across awaits.
 */
export async function runWithCheckpointContext<T>(
  context: CheckpointContext,
  callback: () => T | Promise<T>
): Promise<T> {
  return contextStorage.run(context, callback);
}

/**
 * Express-compatible middleware without an Express dependency. It only accepts
 * request-provided controller details when explicitly enabled by the app.
 */
export function checkpointMiddleware(options: {
  enabled: boolean;
  timeoutMs?: number;
}): (req: { headers?: Record<string, string | string[] | undefined> }, res: unknown, next: () => unknown) => unknown {
  return (req, _res, next) => {
    const headers = req.headers ?? {};
    const header = (name: string): string | undefined => {
      const value = headers[name] ?? headers[name.toLowerCase()];
      return Array.isArray(value) ? value[0] : value;
    };

    // Both switches are required: the host must enable the middleware and the
    // process must explicitly allow BachsProof request headers.
    const requestEnabled = options.enabled && requestHeadersEnabled;
    const context: CheckpointContext | undefined = requestEnabled && header("x-bachsproof-enabled") === "true"
      ? {
          enabled: true,
          controllerUrl: header("x-bachsproof-controller") ?? "",
          sessionId: header("x-bachsproof-session") ?? "",
          participantId: header("x-bachsproof-participant") ?? "",
          token: header("x-bachsproof-token") ?? "",
          timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
        }
      : undefined;

    if (!context || !context.controllerUrl || !context.sessionId || !context.participantId || !context.token) {
      return next();
    }
    return contextStorage.run(context, next);
  };
}

/** Resolve the request-local context before falling back to global configuration. */
function currentContext(): CheckpointContext | undefined {
  return contextStorage.getStore() ?? globalConfig;
}

/**
 * Wait at a named application checkpoint. Disabled calls return before any
 * network work, while enabled calls hold the request until release/abort.
 */
export async function checkpoint(name: string, options: CheckpointOptions = {}): Promise<void> {
  const context = currentContext();
  if (!context?.enabled) return;
  if (options.signal?.aborted) throw new Error(`BachsProof checkpoint ${name} was cancelled`);

  const controllerUrl = context.controllerUrl.replace(/\/$/, "");
  const url = `${controllerUrl}/sessions/${encodeURIComponent(context.sessionId)}/checkpoints/${encodeURIComponent(name)}/arrive`;
  // One AbortController combines the bounded timeout with caller cancellation.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), context.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    // The controller response is intentionally awaited: the webhook handler
    // cannot continue past the barrier until the orchestrator releases it.
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${context.token}`
      },
      body: JSON.stringify({
        participantId: context.participantId,
        key: options.key,
        metadata: options.metadata
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`BachsProof checkpoint ${name} was not released (${response.status}${detail ? `: ${detail}` : ""})`);
    }
  } catch (error) {
    if ((error as { name?: string }).name === "AbortError") {
      throw new Error(`BachsProof checkpoint ${name} timed out after ${context.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/** Expose a read-only diagnostic view without allowing callers to mutate it. */
export function getCheckpointContext(): Readonly<CheckpointContext> | undefined {
  return currentContext();
}
