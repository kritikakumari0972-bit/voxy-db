/**
 * VoxyDB JavaScript SDK for browsers and Node.js 22+.
 * Store only read-capable keys in public apps. Keep write keys on trusted servers.
 */
export class VoxyDBError extends Error {
  constructor(message, { status = 0, code = "NETWORK_ERROR", details = null } = {}) {
    super(message);
    this.name = "VoxyDBError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function randomIdempotencyKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((part) => part.toString(16).padStart(2, "0")).join("");
}

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export class VoxyDB {
  constructor({ projectId, apiKey, baseUrl, fetch: fetchImpl = globalThis.fetch, timeoutMs = 15000 }) {
    const resolvedBaseUrl = baseUrl || globalThis.location?.origin || "";
    if (!projectId || !apiKey || !resolvedBaseUrl) throw new Error("VoxyDB requires projectId, apiKey and baseUrl");
    if (typeof fetchImpl !== "function") throw new Error("VoxyDB requires a fetch implementation");
    this.projectId = projectId;
    this.apiKey = apiKey;
    this.baseUrl = resolvedBaseUrl.replace(/\/$/, "");
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  collectionUrl(collection) {
    if (!/^[a-z][a-z0-9_]{0,47}$/.test(collection || "")) throw new Error("Invalid VoxyDB collection name");
    return `${this.baseUrl}/v1/projects/${encodeURIComponent(this.projectId)}/collections/${encodeURIComponent(collection)}`;
  }

  async _request(url, { method = "GET", body, idempotencyKey, signal, retries = 0 } = {}) {
    const headers = { Authorization: `Bearer ${this.apiKey}`, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    let attempt = 0;
    while (true) {
      const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timeout = controller ? setTimeout(() => controller.abort(new Error("VoxyDB request timed out")), this.timeoutMs) : null;
      const relayAbort = () => controller?.abort(signal.reason);
      if (signal?.aborted) relayAbort();
      else signal?.addEventListener?.("abort", relayAbort, { once: true });
      try {
        const response = await this.fetch(url, {
          method,
          headers,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          ...(controller ? { signal: controller.signal } : signal ? { signal } : {}),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          const detail = payload.error || {};
          throw new VoxyDBError(detail.message || `VoxyDB request failed (${response.status})`, {
            status: response.status,
            code: detail.code || "REQUEST_FAILED",
            details: payload,
          });
        }
        return payload;
      } catch (error) {
        const isNetwork = !(error instanceof VoxyDBError);
        if (!isNetwork || !idempotencyKey || attempt >= retries || signal?.aborted) {
          if (error instanceof VoxyDBError) throw error;
          throw new VoxyDBError(error?.message || "Network request failed", { code: "NETWORK_ERROR" });
        }
        attempt += 1;
        await wait(Math.min(2000, 250 * (2 ** (attempt - 1))));
      } finally {
        if (timeout) clearTimeout(timeout);
        signal?.removeEventListener?.("abort", relayAbort);
      }
    }
  }

  async request(collection, { id, method = "GET", data, limit, cursor, idempotencyKey, signal, retries = 0 } = {}) {
    const record = id ? `/${encodeURIComponent(id)}` : "";
    const url = new URL(`${this.collectionUrl(collection)}/records${record}`);
    if (limit !== undefined) url.searchParams.set("limit", String(limit));
    if (cursor) url.searchParams.set("cursor", cursor);
    return this._request(url, {
      method,
      ...(data !== undefined ? { body: { data } } : {}),
      idempotencyKey,
      signal,
      retries,
    });
  }

  /** List one page. Pass the returned nextCursor to fetch the next page. */
  list(collection, limit = 50, { cursor, signal } = {}) {
    return this.request(collection, { limit, cursor, signal });
  }

  get(collection, id, options = {}) { return this.request(collection, { id, signal: options.signal }); }

  create(collection, data, options = {}) {
    return this.request(collection, {
      method: "POST", data,
      idempotencyKey: options.idempotencyKey || randomIdempotencyKey(),
      signal: options.signal,
      retries: options.retries ?? 2,
    });
  }

  replace(collection, id, data, options = {}) {
    return this.request(collection, {
      method: "PUT", id, data,
      idempotencyKey: options.idempotencyKey || randomIdempotencyKey(),
      signal: options.signal,
      retries: options.retries ?? 2,
    });
  }

  update(collection, id, data, options = {}) {
    return this.request(collection, {
      method: "PATCH", id, data,
      idempotencyKey: options.idempotencyKey || randomIdempotencyKey(),
      signal: options.signal,
      retries: options.retries ?? 2,
    });
  }

  delete(collection, id, options = {}) {
    return this.request(collection, {
      method: "DELETE", id,
      idempotencyKey: options.idempotencyKey || randomIdempotencyKey(),
      signal: options.signal,
      retries: options.retries ?? 2,
    });
  }

  async changes(collection, { after = 0, limit = 100, signal } = {}) {
    const url = new URL(`${this.collectionUrl(collection)}/changes`);
    url.searchParams.set("after", String(after));
    url.searchParams.set("limit", String(limit));
    return this._request(url, { signal });
  }

  /**
   * Subscribe to durable changes. Supply the `cursor` returned by list() after
   * loading the initial snapshot. Reconnects fetch missed events from the log.
   * If a cursor has expired, onSnapshotRequired should reload the collection and
   * return its new snapshot cursor (or a number). Events are ordered per collection.
   */
  async subscribe(collection, onEvent, options = {}) {
    if (typeof onEvent !== "function") throw new Error("VoxyDB.subscribe requires an event callback");
    if (typeof WebSocket === "undefined") throw new Error("WebSocket is not available in this runtime");
    const onStatus = typeof options.onStatus === "function" ? options.onStatus : () => {};
    const onSnapshotRequired = typeof options.onSnapshotRequired === "function" ? options.onSnapshotRequired : null;
    let lastSeq = Number.isSafeInteger(options.cursor) && options.cursor >= 0 ? options.cursor : 0;
    let stopped = false;
    let socket = null;
    let retryTimer = null;
    let retryDelay = 1000;
    let syncing = false;
    let syncAgain = false;

    const emit = (event) => {
      if (Number.isSafeInteger(event.seq)) lastSeq = Math.max(lastSeq, event.seq);
      try { onEvent(event); }
      catch (error) { queueMicrotask(() => { throw error; }); }
    };

    const catchUp = async () => {
      if (syncing) { syncAgain = true; return; }
      syncing = true;
      try {
        do {
          syncAgain = false;
          const result = await this.changes(collection, { after: lastSeq, limit: 500 });
          for (const event of result.changes || []) {
            if (!Number.isSafeInteger(event.seq) || event.seq <= lastSeq) continue;
            emit(event);
          }
          if (result.hasMore) syncAgain = true;
          else if (Number.isSafeInteger(result.cursor)) lastSeq = Math.max(lastSeq, result.cursor);
        } while (syncAgain && !stopped);
      } catch (error) {
        if (error instanceof VoxyDBError && error.status === 410 && error.code === "CURSOR_EXPIRED") {
          onStatus("snapshot_required", error);
          if (onSnapshotRequired) {
            const nextCursor = await onSnapshotRequired(error.details);
            if (Number.isSafeInteger(nextCursor) && nextCursor >= 0) lastSeq = nextCursor;
          } else if (Number.isSafeInteger(error.details?.cursor)) {
            // Keep the subscription alive. The caller is notified that it must
            // refresh its data snapshot to cover events older than retention.
            lastSeq = error.details.cursor;
          }
        } else {
          onStatus("sync_error", error);
        }
      } finally {
        syncing = false;
      }
    };

    const connect = async () => {
      if (stopped) return;
      onStatus("connecting");
      try {
        const ticketUrl = `${this.collectionUrl(collection)}/realtime-ticket`;
        const ticketPayload = await this._request(ticketUrl, { method: "POST", body: {} });
        if (stopped) return;
        const wsUrl = new URL(`${this.collectionUrl(collection)}/realtime`);
        wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
        wsUrl.searchParams.set("ticket", ticketPayload.ticket);
        socket = new WebSocket(wsUrl);
        socket.addEventListener("open", () => {
          retryDelay = 1000;
          onStatus("connected");
          catchUp();
        });
        socket.addEventListener("message", (message) => {
          let payload;
          try { payload = JSON.parse(message.data); } catch { return; }
          if (payload.type === "ready" || payload.type === "pong") return;
          // WebSocket is a wake-up signal; replay from D1 is the source of truth.
          catchUp();
        });
        socket.addEventListener("error", () => onStatus("error", new Error("VoxyDB realtime socket error")));
        socket.addEventListener("close", () => {
          if (stopped) return;
          onStatus("reconnecting");
          retryTimer = setTimeout(connect, retryDelay);
          retryDelay = Math.min(30000, retryDelay * 2);
        }, { once: true });
      } catch (error) {
        if (stopped) return;
        onStatus("error", error instanceof Error ? error : new Error(String(error)));
        retryTimer = setTimeout(connect, retryDelay);
        retryDelay = Math.min(30000, retryDelay * 2);
      }
    };

    await connect();
    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (socket && socket.readyState < 2) socket.close(1000, "Subscription stopped");
      onStatus("disconnected");
    };
  }
}

// Backwards-compatible class aliases for apps using the original NovaDB SDK.
export const NovaDB = VoxyDB;
export const NovaDBError = VoxyDBError;

export default VoxyDB;
