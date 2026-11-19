import {
  DriveApiError,
  createDriveRecordFile,
  createDriveRootFolder,
  decryptRefreshToken,
  deleteDriveRecordFile,
  encryptRefreshToken,
  findDriveRecordFile,
  readDriveRecordFile,
  refreshDriveAccessToken,
  updateDriveRecordFile,
  verifyDriveRootFolder,
} from "./google-drive.js";
import { RealtimeHub } from "./realtime-hub.js";

const SESSION_COOKIE = "__Host-voxydb_session";
const GOOGLE_OAUTH_COOKIE = "__Host-voxydb_oauth";
const DRIVE_OAUTH_COOKIE = "__Host-voxydb_drive_oauth";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_RECORD_BYTES = 32 * 1024;
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
const CHANGE_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const COLLECTION_RE = /^[a-z][a-z0-9_]{0,47}$/;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

function error(message, status = 400, code = "BAD_REQUEST", headers = {}) {
  return json({ error: { code, message } }, status, headers);
}

function randomBytes(length = 32) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function sha256(value) {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

function getCookie(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  for (const part of cookie.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function setSessionCookie(token, maxAge = SESSION_TTL_SECONDS) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function getPublicOrigin(env, url) {
  const configured = String(env.PUBLIC_BASE_URL || url.origin).trim().replace(/\/$/, "");
  let parsed;
  try { parsed = new URL(configured); }
  catch { throw new HttpError(500, "PUBLIC_BASE_URL must be a valid HTTPS origin", "PUBLIC_BASE_URL_INVALID"); }
  const localHttp = parsed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(parsed.hostname);
  if ((!localHttp && parsed.protocol !== "https:") || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new HttpError(500, "PUBLIC_BASE_URL must be an HTTPS origin without a path", "PUBLIC_BASE_URL_INVALID");
  }
  return parsed.origin;
}

function requireSameOrigin(request, url, env) {
  const origin = request.headers.get("Origin");
  if (!origin || origin !== getPublicOrigin(env, url)) {
    throw new HttpError(403, "Cross-origin dashboard request blocked", "CSRF_BLOCKED");
  }
}

class HttpError extends Error {
  constructor(status, message, code = "REQUEST_FAILED") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function readJson(request, maximum = MAX_JSON_BYTES) {
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > maximum) throw new HttpError(413, "Request body is too large", "BODY_TOO_LARGE");
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maximum) throw new HttpError(413, "Request body is too large", "BODY_TOO_LARGE");
  try {
    return JSON.parse(raw || "{}");
  } catch {
    throw new HttpError(400, "Request body must be valid JSON", "INVALID_JSON");
  }
}

function validRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateRecord(value) {
  if (!validRecord(value)) throw new HttpError(422, "A record must be a JSON object", "INVALID_RECORD");
  const encoded = JSON.stringify(value);
  if (new TextEncoder().encode(encoded).byteLength > MAX_RECORD_BYTES) {
    throw new HttpError(413, "Record exceeds the 32 KB limit", "RECORD_TOO_LARGE");
  }
  return encoded;
}

function validateCollectionName(name) {
  if (!COLLECTION_RE.test(name || "")) {
    throw new HttpError(422, "Collection names must start with a lowercase letter and contain only lowercase letters, numbers, or underscores (48 characters max)", "INVALID_COLLECTION_NAME");
  }
  return name;
}

function projectId() {
  return `prj_${base64url(randomBytes(12))}`;
}

function recordId() {
  return `rec_${base64url(randomBytes(12))}`;
}

function apiKeyValue() {
  return `ndb_live_${base64url(randomBytes(32))}`;
}

function safeOriginList(value) {
  if (!value) return [];
  const origins = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (origins.length > 10) throw new HttpError(422, "Maximum 10 allowed origins", "TOO_MANY_ORIGINS");
  for (const origin of origins) {
    let parsed;
    try { parsed = new URL(origin); } catch { throw new HttpError(422, `Invalid origin: ${origin}`, "INVALID_ORIGIN"); }
    if (!/^https?:$/.test(parsed.protocol) || parsed.origin !== origin) {
      throw new HttpError(422, `Origins must be exact http(s) origins without paths: ${origin}`, "INVALID_ORIGIN");
    }
  }
  return origins;
}

async function createSession(db, userId) {
  const rawToken = base64url(randomBytes(32));
  const tokenHash = await sha256(rawToken);
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  await db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(tokenHash, userId, expiresAt, new Date().toISOString()).run();
  return rawToken;
}

async function verifyGoogleIdToken(token, env, expectedNonce) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new HttpError(401, "Google returned an invalid identity token", "OAUTH_INVALID_TOKEN");
  let header;
  let claims;
  try {
    header = JSON.parse(new TextDecoder().decode(decodeBase64url(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(decodeBase64url(parts[1])));
  } catch {
    throw new HttpError(401, "Google returned an invalid identity token", "OAUTH_INVALID_TOKEN");
  }
  if (header.alg !== "RS256" || !header.kid) throw new HttpError(401, "Unsupported identity-token signature", "OAUTH_INVALID_TOKEN");
  const keyResponse = await fetch("https://www.googleapis.com/oauth2/v3/certs", { cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!keyResponse.ok) throw new HttpError(503, "Could not verify Google identity right now", "OAUTH_VERIFY_UNAVAILABLE");
  const keySet = await keyResponse.json();
  const jwk = keySet.keys?.find((key) => key.kid === header.kid && key.kty === "RSA");
  if (!jwk) throw new HttpError(401, "Unknown identity-token signing key", "OAUTH_INVALID_TOKEN");
  const publicKey = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const validSignature = await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, publicKey, decodeBase64url(parts[2]), signed);
  const now = Math.floor(Date.now() / 1000);
  const audienceValid = Array.isArray(claims.aud) ? claims.aud.includes(env.GOOGLE_CLIENT_ID) : claims.aud === env.GOOGLE_CLIENT_ID;
  if (!validSignature || !audienceValid || !["accounts.google.com", "https://accounts.google.com"].includes(claims.iss) ||
      !claims.sub || !claims.email || claims.email_verified !== true || claims.nonce !== expectedNonce ||
      !Number.isFinite(claims.exp) || claims.exp <= now || (claims.iat && claims.iat > now + 60)) {
    throw new HttpError(401, "Google identity could not be verified", "OAUTH_INVALID_TOKEN");
  }
  return {
    googleSub: claims.sub,
    email: String(claims.email).toLowerCase(),
    name: String(claims.name || claims.email).slice(0, 120),
    avatarUrl: typeof claims.picture === "string" ? claims.picture : null,
  };
}

async function claimLegacyAdminOwnership(db, userId) {
  // v0.3 created a synthetic admin owner. The first returning Google user claims
  // those projects so an upgrade does not hide existing databases or Drive links.
  const legacy = await db.prepare("SELECT id FROM users WHERE google_sub = 'voxydb-local-admin' LIMIT 1").first();
  if (!legacy?.id || legacy.id === userId) return;
  const existingDrive = await db.prepare("SELECT user_id FROM drive_connections WHERE user_id = ? LIMIT 1").bind(userId).first();
  const legacyDrive = await db.prepare("SELECT user_id FROM drive_connections WHERE user_id = ? LIMIT 1").bind(legacy.id).first();
  const statements = [
    db.prepare("UPDATE projects SET owner_id = ? WHERE owner_id = ?").bind(userId, legacy.id),
    db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(legacy.id),
  ];
  if (!existingDrive && legacyDrive) {
    statements.push(db.prepare("UPDATE drive_connections SET user_id = ? WHERE user_id = ?").bind(userId, legacy.id));
  }
  statements.push(db.prepare("DELETE FROM users WHERE id = ?").bind(legacy.id));
  await db.batch(statements);
}

async function googleSignInStart(request, env, url) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return error("Google sign-in is not configured. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET as Worker secrets.", 503, "AUTH_NOT_CONFIGURED");
  }
  const state = base64url(randomBytes(24));
  const nonce = base64url(randomBytes(24));
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const payload = base64url(new TextEncoder().encode(JSON.stringify({ state, nonce, verifier, expires: Date.now() + 10 * 60 * 1000 })));
  const authorize = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorize.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${getPublicOrigin(env, url)}/api/auth/google/callback`,
    response_type: "code",
    scope: "openid email profile",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return new Response(null, { status: 302, headers: {
    Location: authorize.toString(),
    "Set-Cookie": `${GOOGLE_OAUTH_COOKIE}=${payload}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    "Cache-Control": "no-store",
  } });
}

async function googleSignInCallback(request, env, url) {
  const oauthCookie = getCookie(request, GOOGLE_OAUTH_COOKIE);
  const clearOAuth = `${GOOGLE_OAUTH_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
  if (!oauthCookie) return error("Sign-in session expired. Please try again.", 400, "OAUTH_STATE_MISSING", { "Set-Cookie": clearOAuth });
  let pending;
  try { pending = JSON.parse(new TextDecoder().decode(decodeBase64url(oauthCookie))); }
  catch { return error("Invalid sign-in session. Please try again.", 400, "OAUTH_STATE_INVALID", { "Set-Cookie": clearOAuth }); }
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!state || state !== pending.state || pending.expires < Date.now() || !code) {
    return error("Google sign-in could not be completed. Please try again.", 400, "OAUTH_STATE_MISMATCH", { "Set-Cookie": clearOAuth });
  }
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${getPublicOrigin(env, url)}/api/auth/google/callback`,
      grant_type: "authorization_code",
      code_verifier: pending.verifier,
    }),
  });
  const tokenData = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !tokenData.id_token) {
    return error("Google token exchange failed. Please try again.", 401, "OAUTH_TOKEN_EXCHANGE_FAILED", { "Set-Cookie": clearOAuth });
  }
  const profile = await verifyGoogleIdToken(tokenData.id_token, env, pending.nonce);
  const now = new Date().toISOString();
  const generatedId = `usr_${base64url(randomBytes(12))}`;
  const userRow = await env.DB.prepare(
    `INSERT INTO users (id, google_sub, email, display_name, avatar_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(google_sub) DO UPDATE SET email = excluded.email, display_name = excluded.display_name,
       avatar_url = excluded.avatar_url, updated_at = excluded.updated_at
     RETURNING id`
  ).bind(generatedId, profile.googleSub, profile.email, profile.name, profile.avatarUrl, now, now).first();
  await claimLegacyAdminOwnership(env.DB, userRow.id);
  const session = await createSession(env.DB, userRow.id);
  const headers = new Headers({ Location: `${getPublicOrigin(env, url)}/`, "Cache-Control": "no-store" });
  headers.append("Set-Cookie", setSessionCookie(session));
  headers.append("Set-Cookie", clearOAuth);
  return new Response(null, { status: 302, headers });
}

async function getUser(request, env) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const result = await env.DB.prepare(
    `SELECT u.id, u.email, u.display_name, u.avatar_url
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? LIMIT 1`
  ).bind(tokenHash, Math.floor(Date.now() / 1000)).first();
  return result || null;
}

async function requireUser(request, env) {
  const user = await getUser(request, env);
  if (!user) throw new HttpError(401, "Sign in to continue", "UNAUTHENTICATED");
  return user;
}

async function requireProject(db, userId, id) {
  const project = await db.prepare("SELECT id, owner_id, name, created_at, storage_backend FROM projects WHERE id = ? AND owner_id = ? LIMIT 1")
    .bind(id, userId).first();
  if (!project) throw new HttpError(404, "Project not found", "PROJECT_NOT_FOUND");
  return project;
}

async function getDriveConnection(db, userId) {
  return db.prepare("SELECT user_id, google_email, refresh_token_enc, root_folder_id, connected_at FROM drive_connections WHERE user_id = ? LIMIT 1")
    .bind(userId).first();
}

async function getDriveContext(env, userId) {
  const connection = await getDriveConnection(env.DB, userId);
  if (!connection) throw new HttpError(409, "Connect a Google Drive account before enabling Drive storage", "DRIVE_NOT_CONNECTED");
  const accessToken = await refreshDriveAccessToken(env, connection.refresh_token_enc);
  let rootFolderId = connection.root_folder_id;
  if (!rootFolderId) {
    const folder = await createDriveRootFolder(accessToken);
    rootFolderId = folder.id;
    await env.DB.prepare("UPDATE drive_connections SET root_folder_id = ? WHERE user_id = ?")
      .bind(rootFolderId, userId).run();
  }
  return { accessToken, rootFolderId, connection };
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function rowToCachedRecord(row) {
  return { id: row.id, data: JSON.parse(row.data_json), createdAt: row.created_at, updatedAt: row.updated_at };
}

async function readProjectRecords(env, project, rows, ownerId) {
  // D1 is the low-latency operational store. In Drive mode every committed write
  // is mirrored by the durable outbox; reads stay consistent during Drive outages.
  return rows.map(rowToCachedRecord);
}

function assertProjectWritable(project) {
  if (project.storage_backend === "migrating") {
    throw new HttpError(409, "This project's records are being moved to Google Drive. Wait for migration to finish, then retry.", "STORAGE_MIGRATION_IN_PROGRESS");
  }
}

function scheduleBackground(ctx, promise, label) {
  const guarded = Promise.resolve(promise).catch((err) => console.error(`VoxyDB ${label} background task failed:`, err?.code || err?.message || "unknown"));
  if (ctx?.waitUntil) ctx.waitUntil(guarded);
  else return guarded;
}

async function publishRealtime(env, projectIdValue, collectionName, event) {
  if (!env.REALTIME) return { delivered: 0, skipped: true };
  const objectId = env.REALTIME.idFromName(`${projectIdValue}:${collectionName}`);
  const stub = env.REALTIME.get(objectId);
  const response = await stub.fetch("https://voxydb-realtime.internal/publish", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...event, projectId: projectIdValue, collection: collectionName, timestamp: new Date().toISOString() }),
  });
  if (!response.ok) throw new Error(`Realtime hub returned ${response.status}`);
  return response.json();
}

function scheduleRealtime(ctx, env, projectIdValue, collectionName, event) {
  return scheduleBackground(ctx, publishRealtime(env, projectIdValue, collectionName, event), "realtime publish");
}

async function createRealtimeTicket(db, projectIdValue, collectionId, expiresIn = 60) {
  const value = base64url(randomBytes(32));
  const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
  await db.prepare("INSERT INTO realtime_tickets (token_hash, project_id, collection_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(await sha256(value), projectIdValue, collectionId, expiresAt, new Date().toISOString()).run();
  return { ticket: value, expiresIn };
}

function driveSyncStatement(env, projectIdValue, recordIdValue, collectionName, operation, payload, driveFileId = null) {
  const now = new Date().toISOString();
  const id = `sync_${base64url(randomBytes(12))}`;
  const nowSeconds = Math.floor(Date.now() / 1000);
  return env.DB.prepare(
    `INSERT INTO drive_sync_jobs (id, project_id, record_id, collection_name, operation, payload_json, drive_file_id,
      version, attempts, next_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?)
     ON CONFLICT(record_id) DO UPDATE SET id = excluded.id, project_id = excluded.project_id,
       collection_name = excluded.collection_name, operation = excluded.operation, payload_json = excluded.payload_json,
       drive_file_id = COALESCE(excluded.drive_file_id, drive_sync_jobs.drive_file_id),
       version = drive_sync_jobs.version + 1, attempts = 0, next_attempt_at = excluded.next_attempt_at,
       last_error_code = NULL, updated_at = excluded.updated_at`
  ).bind(id, projectIdValue, recordIdValue, collectionName, operation, payload ? JSON.stringify(payload) : null,
    driveFileId, nowSeconds, now, now);
}

function makeChangeDetails(projectIdValue, collectionId, event) {
  return {
    eventId: `evt_${base64url(randomBytes(12))}`,
    projectId: projectIdValue,
    collectionId,
    event,
    recordId: event.record?.id || event.id,
  };
}

function changeEventStatement(env, details) {
  return env.DB.prepare(
    `INSERT INTO change_events (event_id, project_id, collection_id, event_type, record_id, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(details.eventId, details.projectId, details.collectionId, details.event.type,
    details.recordId, JSON.stringify(details.event), new Date().toISOString());
}

async function findIdempotencyReplay(db, details) {
  if (!details) return null;
  const row = await db.prepare(
    "SELECT request_hash, response_json, status_code, expires_at FROM idempotency_keys WHERE key_hash = ? LIMIT 1"
  ).bind(details.keyHash).first();
  if (!row) return null;
  if (Number(row.expires_at) <= Math.floor(Date.now() / 1000)) {
    await db.prepare("DELETE FROM idempotency_keys WHERE key_hash = ?").bind(details.keyHash).run();
    return null;
  }
  if (row.request_hash !== details.requestHash) {
    throw new HttpError(409, "This Idempotency-Key was already used with a different request", "IDEMPOTENCY_KEY_REUSED");
  }
  return { replay: true, payload: JSON.parse(row.response_json), statusCode: Number(row.status_code) };
}

async function prepareIdempotency(db, request, projectIdValue, collectionId, method, path, body) {
  const rawKey = request.headers.get("Idempotency-Key");
  if (!rawKey) return null;
  if (rawKey.length > 128 || !/^[A-Za-z0-9._:-]{1,128}$/.test(rawKey)) {
    throw new HttpError(422, "Idempotency-Key must contain 1–128 letters, numbers, dots, underscores, colons or hyphens", "INVALID_IDEMPOTENCY_KEY");
  }
  const keyHash = await sha256(`${projectIdValue}\0${collectionId}\0${rawKey}`);
  const requestHash = await sha256(JSON.stringify({ method, path, body: body ?? null }));
  const details = { keyHash, requestHash, projectId: projectIdValue, collectionId };
  return { ...details, ...(await findIdempotencyReplay(db, details) || {}) };
}

function idempotencyStatement(env, details, payload, statusCode) {
  if (!details) return null;
  const now = Math.floor(Date.now() / 1000);
  return env.DB.prepare(
    `INSERT INTO idempotency_keys (key_hash, project_id, collection_id, request_hash, response_json, status_code, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(details.keyHash, details.projectId, details.collectionId, details.requestHash,
    JSON.stringify(payload), statusCode, now + IDEMPOTENCY_TTL_SECONDS, new Date().toISOString());
}

async function commitRecordMutation(env, projectIdValue, storageBackend, mutation, syncDetails = null, changeDetails = null, idempotency = null, responsePayload = null, responseStatus = 200) {
  // D1 batch is transactional: the record, Drive outbox, durable change event,
  // and idempotency response either all commit or none do.
  const statements = [mutation];
  if (storageBackend === "google_drive" && syncDetails) statements.push(driveSyncStatement(env, projectIdValue, ...syncDetails));
  if (changeDetails) statements.push(changeEventStatement(env, changeDetails));
  const idem = idempotencyStatement(env, idempotency, responsePayload, responseStatus);
  if (idem) statements.push(idem);
  try {
    await env.DB.batch(statements);
  } catch (err) {
    // Two simultaneous retries with the same key may race. The unique key insert
    // lets only one batch commit; the loser returns the winner's stored response.
    if (idempotency) {
      const replay = await findIdempotencyReplay(env.DB, idempotency);
      if (replay) return replay;
    }
    throw err;
  }
  let seq = null;
  if (changeDetails) {
    const row = await env.DB.prepare("SELECT seq FROM change_events WHERE event_id = ? LIMIT 1")
      .bind(changeDetails.eventId).first();
    seq = Number(row?.seq || 0) || null;
  }
  return { replay: false, seq };
}

function decodeRecordCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(decodeBase64url(value)));
    if (typeof parsed.createdAt !== "string" || typeof parsed.id !== "string") throw new Error("Invalid cursor");
    return parsed;
  } catch {
    throw new HttpError(400, "Invalid pagination cursor", "INVALID_CURSOR");
  }
}

function encodeRecordCursor(row) {
  return base64url(new TextEncoder().encode(JSON.stringify({ createdAt: row.created_at, id: row.id })));
}

async function getCollectionSequence(db, projectIdValue, collectionId) {
  // A fresh snapshot must start at least at the retention checkpoint. Otherwise,
  // clients that were offline longer than the replay window would receive a
  // fresh snapshot with cursor 0 and immediately hit CURSOR_EXPIRED again.
  const row = await db.prepare(
    `SELECT MAX(
       COALESCE((SELECT MAX(seq) FROM change_events WHERE project_id = ? AND collection_id = ?), 0),
       COALESCE((SELECT pruned_through_seq FROM change_event_checkpoints WHERE project_id = ? AND collection_id = ?), 0)
     ) AS cursor`
  ).bind(projectIdValue, collectionId, projectIdValue, collectionId).first();
  return Number(row?.cursor || 0);
}

async function listCollectionRecords(db, collectionId, limit, cursorToken = null) {
  const cursor = decodeRecordCursor(cursorToken);
  const query = cursor
    ? `SELECT id, data_json, drive_file_id, created_at, updated_at FROM records
       WHERE collection_id = ? AND (created_at < ? OR (created_at = ? AND id < ?))
       ORDER BY created_at DESC, id DESC LIMIT ?`
    : `SELECT id, data_json, drive_file_id, created_at, updated_at FROM records
       WHERE collection_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`;
  const statement = cursor
    ? db.prepare(query).bind(collectionId, cursor.createdAt, cursor.createdAt, cursor.id, limit + 1)
    : db.prepare(query).bind(collectionId, limit + 1);
  const { results = [] } = await statement.all();
  const hasMore = results.length > limit;
  const page = results.slice(0, limit);
  return { rows: page, nextCursor: hasMore ? encodeRecordCursor(page[page.length - 1]) : null };
}

async function processOneDriveSyncJob(env, job, leaseToken) {
  const project = await env.DB.prepare("SELECT id, owner_id, storage_backend FROM projects WHERE id = ? LIMIT 1")
    .bind(job.project_id).first();
  if (!project || project.storage_backend !== "google_drive") {
    await env.DB.prepare("DELETE FROM drive_sync_jobs WHERE id = ? AND version = ? AND lease_token = ?")
      .bind(job.id, job.version, leaseToken).run();
    return;
  }
  const context = await getDriveContext(env, project.owner_id);
  let fileId = job.drive_file_id || null;
  if (job.operation === "delete") {
    if (!fileId) fileId = (await findDriveRecordFile(context.accessToken, context.rootFolderId, job.record_id))?.id || null;
    if (fileId) {
      try { await deleteDriveRecordFile(context.accessToken, fileId); }
      catch (err) { if (err.status !== 404) throw err; }
    }
  } else {
    const record = JSON.parse(job.payload_json || "{}");
    if (!fileId) fileId = (await findDriveRecordFile(context.accessToken, context.rootFolderId, job.record_id))?.id || null;
    if (fileId) {
      try { await updateDriveRecordFile(context.accessToken, fileId, record); }
      catch (err) {
        if (err.status !== 404) throw err;
        fileId = null;
      }
    }
    if (!fileId) {
      const file = await createDriveRecordFile(context.accessToken, context.rootFolderId, job.project_id, job.collection_name, record);
      fileId = file.id;
    }
    await env.DB.prepare("UPDATE records SET drive_file_id = ? WHERE id = ?").bind(fileId, job.record_id).run();
  }
  await env.DB.prepare("DELETE FROM drive_sync_jobs WHERE id = ? AND version = ? AND lease_token = ?")
    .bind(job.id, job.version, leaseToken).run();
}

async function processDriveSyncJobs(env, limit = 8) {
  if (!env.DB) return { processed: 0, pending: 0 };
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM realtime_tickets WHERE expires_at <= ?").bind(now),
    env.DB.prepare("DELETE FROM idempotency_keys WHERE expires_at <= ?").bind(now),
    env.DB.prepare(
      `INSERT INTO change_event_checkpoints (project_id, collection_id, pruned_through_seq, updated_at)
       SELECT project_id, collection_id, MAX(seq), ? FROM change_events WHERE unixepoch(created_at) < ?
       GROUP BY project_id, collection_id
       ON CONFLICT(project_id, collection_id) DO UPDATE SET
         pruned_through_seq = MAX(change_event_checkpoints.pruned_through_seq, excluded.pruned_through_seq),
         updated_at = excluded.updated_at`
    ).bind(new Date().toISOString(), now - CHANGE_RETENTION_SECONDS),
    env.DB.prepare("DELETE FROM change_events WHERE unixepoch(created_at) < ?").bind(now - CHANGE_RETENTION_SECONDS),
  ]);
  const { results } = await env.DB.prepare(
    "SELECT * FROM drive_sync_jobs WHERE next_attempt_at <= ? AND (lease_until IS NULL OR lease_until <= ?) ORDER BY created_at ASC LIMIT ?"
  ).bind(now, now, limit).all();
  let processed = 0;
  for (const job of results || []) {
    const leaseToken = `lease_${base64url(randomBytes(12))}`;
    const claim = await env.DB.prepare(
      "UPDATE drive_sync_jobs SET lease_token = ?, lease_until = ? WHERE id = ? AND version = ? AND (lease_until IS NULL OR lease_until <= ?)"
    ).bind(leaseToken, now + 90, job.id, job.version, now).run();
    if (!claim.meta?.changes) continue;
    try {
      await processOneDriveSyncJob(env, job, leaseToken);
      processed += 1;
    } catch (err) {
      const attempts = Number(job.attempts || 0) + 1;
      const delay = Math.min(3600, 15 * (2 ** Math.min(attempts - 1, 8)));
      await env.DB.prepare(
        "UPDATE drive_sync_jobs SET attempts = ?, next_attempt_at = ?, lease_token = NULL, lease_until = NULL, last_error_code = ?, updated_at = ? WHERE id = ? AND version = ? AND lease_token = ?"
      ).bind(attempts, now + delay, String(err?.code || "DRIVE_SYNC_FAILED").slice(0, 80), new Date().toISOString(), job.id, job.version, leaseToken).run();
    }
  }
  const pending = await env.DB.prepare("SELECT COUNT(*) AS count FROM drive_sync_jobs").first();
  return { processed, pending: Number(pending?.count || 0) };
}

function scheduleDriveSync(ctx, env, limit = 8) {
  return scheduleBackground(ctx, processDriveSyncJobs(env, limit), "Drive sync");
}

async function consumeRealtimeTicket(env, request, url) {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("WebSocket upgrade required", { status: 426, headers: { Upgrade: "websocket" } });
  }
  const rawTicket = url.searchParams.get("ticket") || "";
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(rawTicket)) return error("A valid one-time realtime ticket is required", 401, "REALTIME_TICKET_REQUIRED");
  const tokenHash = await sha256(rawTicket);
  const ticket = await env.DB.prepare(
    "SELECT token_hash, project_id, collection_id, expires_at FROM realtime_tickets WHERE token_hash = ? LIMIT 1"
  ).bind(tokenHash).first();
  if (!ticket || Number(ticket.expires_at) <= Math.floor(Date.now() / 1000)) {
    if (ticket) await env.DB.prepare("DELETE FROM realtime_tickets WHERE token_hash = ?").bind(tokenHash).run();
    return error("Realtime ticket expired or was already used. Request a new ticket.", 401, "REALTIME_TICKET_EXPIRED");
  }
  await env.DB.prepare("DELETE FROM realtime_tickets WHERE token_hash = ?").bind(tokenHash).run();
  if (!env.REALTIME) return error("Realtime service is not configured. Add the Durable Object binding.", 503, "REALTIME_NOT_CONFIGURED");
  const match = url.pathname.match(/^\/v1\/projects\/([^/]+)\/collections\/([^/]+)\/realtime$/);
  if (!match || decodeURIComponent(match[1]) !== ticket.project_id) return error("Realtime ticket does not match this database route", 403, "REALTIME_TICKET_MISMATCH");
  const collectionName = validateCollectionName(decodeURIComponent(match[2]));
  const collection = await env.DB.prepare("SELECT id FROM collections WHERE id = ? AND project_id = ? LIMIT 1")
    .bind(ticket.collection_id, ticket.project_id).first();
  const collectionByName = await env.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND name = ? LIMIT 1")
    .bind(ticket.project_id, collectionName).first();
  if (!collection || collection.id !== collectionByName?.id) return error("Realtime ticket does not match this collection", 403, "REALTIME_TICKET_MISMATCH");
  const id = env.REALTIME.idFromName(`${ticket.project_id}:${collectionName}`);
  const stub = env.REALTIME.get(id);
  const internal = new Request("https://voxydb-realtime.internal/connect", { method: "GET", headers: { Upgrade: request.headers.get("Upgrade") || "websocket" } });
  return stub.fetch(internal);
}

async function connectDriveStart(request, env, url) {
  await requireUser(request, env);
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return error("Google OAuth is not configured. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET as Worker secrets.", 503, "AUTH_NOT_CONFIGURED");
  }
  if (!env.DRIVE_TOKEN_ENCRYPTION_KEY || env.DRIVE_TOKEN_ENCRYPTION_KEY.length < 32) {
    return error("Add DRIVE_TOKEN_ENCRYPTION_KEY as a Worker secret before connecting Drive.", 503, "DRIVE_ENCRYPTION_NOT_CONFIGURED");
  }
  const state = base64url(randomBytes(24));
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const payload = base64url(new TextEncoder().encode(JSON.stringify({ state, verifier, expires: Date.now() + 10 * 60 * 1000 })));
  const authorize = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorize.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${getPublicOrigin(env, url)}/api/drive/callback`,
    response_type: "code",
    scope: DRIVE_SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
  }).toString();
  return new Response(null, { status: 302, headers: {
    Location: authorize.toString(),
    "Set-Cookie": `${DRIVE_OAUTH_COOKIE}=${payload}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    "Cache-Control": "no-store",
  } });
}

async function connectDriveCallback(request, env, url) {
  const user = await requireUser(request, env);
  const oauthCookie = getCookie(request, DRIVE_OAUTH_COOKIE);
  const clearCookie = `${DRIVE_OAUTH_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
  if (!oauthCookie) return error("Drive connection session expired. Try connecting again.", 400, "DRIVE_OAUTH_STATE_MISSING", { "Set-Cookie": clearCookie });
  let pending;
  try { pending = JSON.parse(new TextDecoder().decode(decodeBase64url(oauthCookie))); }
  catch { return error("Invalid Drive connection session. Try again.", 400, "DRIVE_OAUTH_STATE_INVALID", { "Set-Cookie": clearCookie }); }
  const code = url.searchParams.get("code");
  if (!code || url.searchParams.get("state") !== pending.state || pending.expires < Date.now()) {
    return error("Google Drive authorization was cancelled or expired. Try again.", 400, "DRIVE_OAUTH_STATE_MISMATCH", { "Set-Cookie": clearCookie });
  }
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${getPublicOrigin(env, url)}/api/drive/callback`,
      grant_type: "authorization_code",
      code_verifier: pending.verifier,
    }),
  });
  const tokenData = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !tokenData.access_token) {
    return error("Google could not authorize Drive storage. Check the Drive API settings and try again.", 401, "DRIVE_TOKEN_EXCHANGE_FAILED", { "Set-Cookie": clearCookie });
  }
  const scopes = tokenData.scope ? String(tokenData.scope).split(/\s+/) : [];
  if (tokenData.scope && !scopes.includes(DRIVE_SCOPE)) {
    return error("Google Drive file access was not granted. Approve the requested Drive storage permission.", 403, "DRIVE_SCOPE_MISSING", { "Set-Cookie": clearCookie });
  }
  const existing = await getDriveConnection(env.DB, user.id);
  let rootFolderId = existing?.root_folder_id || null;
  if (rootFolderId) {
    try {
      await verifyDriveRootFolder(tokenData.access_token, rootFolderId);
    } catch (driveError) {
      if (![401, 403, 404].includes(driveError.status)) throw driveError;
      const active = await env.DB.prepare("SELECT COUNT(*) AS count FROM projects WHERE owner_id = ? AND storage_backend IN ('google_drive', 'migrating')")
        .bind(user.id).first();
      if (Number(active?.count || 0) > 0) {
        return error("This Google account cannot access the Drive folder used by active database projects. Switch those projects to D1 before changing the storage account.", 409, "DRIVE_ACCOUNT_IN_USE", { "Set-Cookie": clearCookie });
      }
      rootFolderId = null;
    }
  }
  const refreshToken = tokenData.refresh_token || (existing && rootFolderId ? await decryptRefreshToken(existing.refresh_token_enc, env.DRIVE_TOKEN_ENCRYPTION_KEY) : null);
  if (!refreshToken) {
    return error("Google did not return a long-lived Drive storage token. Disconnect the old Drive after switching all its projects to D1, then connect again.", 401, "DRIVE_REFRESH_TOKEN_MISSING", { "Set-Cookie": clearCookie });
  }
  const encrypted = await encryptRefreshToken(refreshToken, env.DRIVE_TOKEN_ENCRYPTION_KEY);
  if (!rootFolderId) rootFolderId = (await createDriveRootFolder(tokenData.access_token)).id;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO drive_connections (user_id, google_email, refresh_token_enc, root_folder_id, connected_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET google_email = excluded.google_email,
       refresh_token_enc = excluded.refresh_token_enc, root_folder_id = excluded.root_folder_id, connected_at = excluded.connected_at`
  ).bind(user.id, "Drive storage connected", encrypted, rootFolderId, now).run();
  const headers = new Headers({ Location: `${getPublicOrigin(env, url)}/?drive=connected`, "Cache-Control": "no-store" });
  headers.append("Set-Cookie", clearCookie);
  return new Response(null, { status: 302, headers });
}

async function driveAuthApi(request, env, url) {
  if (url.pathname === "/api/drive/connect" && request.method === "GET") return connectDriveStart(request, env, url);
  if (url.pathname === "/api/drive/callback" && request.method === "GET") return connectDriveCallback(request, env, url);
  if (url.pathname === "/api/drive/disconnect" && request.method === "POST") {
    requireSameOrigin(request, url, env);
    const user = await requireUser(request, env);
    const active = await env.DB.prepare("SELECT COUNT(*) AS count FROM projects WHERE owner_id = ? AND storage_backend IN ('google_drive', 'migrating')")
      .bind(user.id).first();
    if (Number(active?.count || 0) > 0) return error("Switch all projects using this Drive connection back to D1 before disconnecting.", 409, "DRIVE_STORAGE_IN_USE");
    await env.DB.prepare("DELETE FROM drive_connections WHERE user_id = ?").bind(user.id).run();
    return json({ ok: true, disconnected: true });
  }
  return null;
}

async function authApi(request, env, url) {
  if (url.pathname === "/api/auth/google/start" && request.method === "GET") return googleSignInStart(request, env, url);
  if (url.pathname === "/api/auth/google/callback" && request.method === "GET") return googleSignInCallback(request, env, url);
  if (url.pathname === "/api/auth/logout" && request.method === "POST") {
    requireSameOrigin(request, url, env);
    const token = getCookie(request, SESSION_COOKIE);
    if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
    return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie() });
  }
  return null;
}

async function dashboardApi(request, env, url, ctx) {
  const authResponse = await authApi(request, env, url);
  if (authResponse) return authResponse;
  const driveAuthResponse = await driveAuthApi(request, env, url);
  if (driveAuthResponse) return driveAuthResponse;
  if (url.pathname === "/api/health" && request.method === "GET") {
    await env.DB.prepare("SELECT 1 AS ok").first();
    return json({ ok: true, service: "VoxyDB", database: "connected", timestamp: new Date().toISOString() });
  }
  if (url.pathname === "/api/me" && request.method === "GET") {
    const user = await getUser(request, env);
    if (!user) return json({ authenticated: false }, 200);
    return json({ authenticated: true, user });
  }

  const user = await requireUser(request, env);
  if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) requireSameOrigin(request, url, env);

  if (url.pathname === "/api/drive/connection" && request.method === "GET") {
    const connection = await getDriveConnection(env.DB, user.id);
    const active = await env.DB.prepare("SELECT COUNT(*) AS count FROM projects WHERE owner_id = ? AND storage_backend IN ('google_drive', 'migrating')")
      .bind(user.id).first();
    return json({ connected: Boolean(connection), label: connection ? "Drive storage authorized" : null, connectedAt: connection?.connected_at || null, storageFolderReady: Boolean(connection?.root_folder_id), canDisconnect: Number(active?.count || 0) === 0 });
  }

  if (url.pathname === "/api/projects" && request.method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT p.id, p.name, p.created_at,
        (SELECT COUNT(*) FROM collections c WHERE c.project_id = p.id) AS collection_count,
        (SELECT COUNT(*) FROM records r JOIN collections c ON c.id = r.collection_id WHERE c.project_id = p.id) AS record_count
       FROM projects p WHERE p.owner_id = ? ORDER BY p.created_at DESC`
    ).bind(user.id).all();
    return json({ projects: results });
  }

  if (url.pathname === "/api/projects" && request.method === "POST") {
    const body = await readJson(request);
    const name = String(body.name || "").trim().slice(0, 64);
    if (name.length < 2) return error("Project name must be at least 2 characters", 422, "INVALID_PROJECT_NAME");
    const projectCount = await env.DB.prepare("SELECT COUNT(*) AS count FROM projects WHERE owner_id = ?").bind(user.id).first();
    if (Number(projectCount?.count || 0) >= 10) return error("This database instance allows up to 10 projects", 429, "PROJECT_LIMIT_REACHED");
    const id = projectId();
    const driveConnection = await getDriveConnection(env.DB, user.id);
    const defaultBackend = driveConnection ? "google_drive" : "d1";
    await env.DB.prepare("INSERT INTO projects (id, owner_id, name, created_at, storage_backend) VALUES (?, ?, ?, ?, ?)")
      .bind(id, user.id, name, new Date().toISOString(), defaultBackend).run();
    return json({ project: { id, name, storage_backend: defaultBackend } }, 201);
  }

  const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)(?:\/(.*))?$/);
  if (projectMatch) {
    const project = await requireProject(env.DB, user.id, projectMatch[1]);
    const suffix = projectMatch[2] || "";

    if (suffix === "storage" && request.method === "GET") {
      const connection = await getDriveConnection(env.DB, project.owner_id);
      const counts = await env.DB.prepare(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN r.drive_file_id IS NOT NULL THEN 1 ELSE 0 END) AS drive_backed
         FROM records r JOIN collections c ON c.id = r.collection_id WHERE c.project_id = ?`
      ).bind(project.id).first();
      const syncQueue = await env.DB.prepare("SELECT COUNT(*) AS pending, MAX(attempts) AS max_attempts, MAX(last_error_code) AS last_error FROM drive_sync_jobs WHERE project_id = ?")
        .bind(project.id).first();
      return json({ storage: { backend: project.storage_backend || "d1", totalRecords: Number(counts?.total || 0), driveBackedRecords: Number(counts?.drive_backed || 0), driveConnected: Boolean(connection), driveLabel: connection ? "Drive storage authorized" : null, connectedAt: connection?.connected_at || null, syncPending: Number(syncQueue?.pending || 0), syncMaxAttempts: Number(syncQueue?.max_attempts || 0), syncLastError: syncQueue?.last_error || null } });
    }

    if (suffix === "storage/migrate" && request.method === "POST") {
      const connection = await getDriveConnection(env.DB, project.owner_id);
      if (!connection) return error("Connect the Google Drive storage account used by this project before starting migration", 409, "DRIVE_NOT_CONNECTED");
      if (project.storage_backend === "d1") {
        await env.DB.prepare("UPDATE projects SET storage_backend = 'migrating' WHERE id = ? AND storage_backend = 'd1'")
          .bind(project.id).run();
      }
      const context = await getDriveContext(env, project.owner_id);
      const { results: pending } = await env.DB.prepare(
        `SELECT r.id, r.data_json, r.created_at, r.updated_at, c.name AS collection_name
         FROM records r JOIN collections c ON c.id = r.collection_id
         WHERE c.project_id = ? AND r.drive_file_id IS NULL
         ORDER BY r.created_at ASC LIMIT 25`
      ).bind(project.id).all();
      let migrated = 0;
      for (const row of pending) {
        const record = { id: row.id, data: JSON.parse(row.data_json), createdAt: row.created_at, updatedAt: row.updated_at };
        const existingFile = await findDriveRecordFile(context.accessToken, context.rootFolderId, row.id);
        let driveFileId = existingFile?.id || null;
        if (driveFileId) {
          await updateDriveRecordFile(context.accessToken, driveFileId, record);
        } else {
          const file = await createDriveRecordFile(context.accessToken, context.rootFolderId, project.id, row.collection_name, record);
          driveFileId = file.id;
        }
        await env.DB.prepare("UPDATE records SET drive_file_id = ? WHERE id = ? AND drive_file_id IS NULL")
          .bind(driveFileId, row.id).run();
        migrated += 1;
      }
      const remaining = await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM records r JOIN collections c ON c.id = r.collection_id WHERE c.project_id = ? AND r.drive_file_id IS NULL"
      ).bind(project.id).first();
      const remainingCount = Number(remaining?.count || 0);
      const backend = remainingCount === 0 ? "google_drive" : "migrating";
      if (backend === "google_drive") {
        await env.DB.prepare("UPDATE projects SET storage_backend = 'google_drive' WHERE id = ?")
          .bind(project.id).run();
      }
      return json({ migrated, remaining: remainingCount, backend, batchSize: 25 });
    }

    if (suffix === "storage/use-d1" && request.method === "POST") {
      await env.DB.batch([
        env.DB.prepare("UPDATE projects SET storage_backend = 'd1' WHERE id = ?").bind(project.id),
        env.DB.prepare("UPDATE records SET drive_file_id = NULL WHERE collection_id IN (SELECT id FROM collections WHERE project_id = ?)").bind(project.id),
        env.DB.prepare("DELETE FROM drive_sync_jobs WHERE project_id = ?").bind(project.id),
      ]);
      return json({ ok: true, backend: "d1", driveFilesRetained: true });
    }

    const dashboardRealtimeTicket = suffix.match(/^collections\/([^/]+)\/realtime-ticket$/);
    if (dashboardRealtimeTicket && request.method === "POST") {
      const collectionName = validateCollectionName(decodeURIComponent(dashboardRealtimeTicket[1]));
      const collectionRow = await env.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND name = ? LIMIT 1")
        .bind(project.id, collectionName).first();
      if (!collectionRow) return error("Collection not found", 404, "COLLECTION_NOT_FOUND");
      const issued = await createRealtimeTicket(env.DB, project.id, collectionRow.id);
      return json(issued, 201);
    }

    if (suffix === "collections" && request.method === "GET") {
      const { results } = await env.DB.prepare(
        `SELECT c.id, c.name, c.created_at,
          (SELECT COUNT(*) FROM records r WHERE r.collection_id = c.id) AS record_count
         FROM collections c WHERE c.project_id = ? ORDER BY c.name`
      ).bind(project.id).all();
      return json({ collections: results });
    }
    if (suffix === "collections" && request.method === "POST") {
      const body = await readJson(request);
      const name = validateCollectionName(String(body.name || ""));
      const collectionCount = await env.DB.prepare("SELECT COUNT(*) AS count FROM collections WHERE project_id = ?").bind(project.id).first();
      if (Number(collectionCount?.count || 0) >= 50) return error("This starter version allows up to 50 collections per project", 429, "COLLECTION_LIMIT_REACHED");
      const id = `col_${base64url(randomBytes(12))}`;
      try {
        await env.DB.prepare("INSERT INTO collections (id, project_id, name, created_at) VALUES (?, ?, ?, ?)")
          .bind(id, project.id, name, new Date().toISOString()).run();
      } catch (e) {
        if (String(e).includes("UNIQUE")) return error("That collection already exists", 409, "COLLECTION_EXISTS");
        throw e;
      }
      return json({ collection: { id, name } }, 201);
    }

    const keysMatch = suffix.match(/^keys(?:\/([^/]+))?$/);
    if (keysMatch && !keysMatch[1] && request.method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT id, label, key_prefix, scopes, allowed_origins, created_at, revoked_at, last_used_at FROM api_keys WHERE project_id = ? ORDER BY created_at DESC"
      ).bind(project.id).all();
      return json({ keys: results });
    }
    if (keysMatch && !keysMatch[1] && request.method === "POST") {
      const body = await readJson(request);
      const label = String(body.label || "App key").trim().slice(0, 64) || "App key";
      const scopes = ["read", "write", "read_write"].includes(body.scopes) ? body.scopes : "read";
      const origins = safeOriginList(String(body.allowedOrigins || ""));
      const activeKeyCount = await env.DB.prepare("SELECT COUNT(*) AS count FROM api_keys WHERE project_id = ? AND revoked_at IS NULL").bind(project.id).first();
      if (Number(activeKeyCount?.count || 0) >= 20) return error("This starter version allows up to 20 active API keys per project", 429, "API_KEY_LIMIT_REACHED");
      const raw = apiKeyValue();
      const id = `key_${base64url(randomBytes(12))}`;
      await env.DB.prepare(
        `INSERT INTO api_keys (id, project_id, label, key_prefix, key_hash, scopes, allowed_origins, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(id, project.id, label, raw.slice(0, 18), await sha256(raw), scopes, JSON.stringify(origins), new Date().toISOString()).run();
      return json({ key: { id, label, value: raw, prefix: raw.slice(0, 18), scopes, allowed_origins: origins } }, 201);
    }

    const collRecords = suffix.match(/^collections\/([^/]+)\/records(?:\/([^/]+))?$/);
    if (collRecords) {
      const collection = validateCollectionName(decodeURIComponent(collRecords[1]));
      const targetId = collRecords[2] || null;
      const collectionRow = await env.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND name = ? LIMIT 1")
        .bind(project.id, collection).first();
      if (!collectionRow) return error("Collection not found", 404, "COLLECTION_NOT_FOUND");

      if (!targetId && request.method === "GET") {
        const limitRaw = url.searchParams.get("limit") || "50";
        if (!/^\d+$/.test(limitRaw)) return error("The limit must be an integer from 1 to 100", 400, "INVALID_LIMIT");
        const limit = Math.min(Math.max(Number(limitRaw), 1), 100);
        const cursor = await getCollectionSequence(env.DB, project.id, collectionRow.id);
        const page = await listCollectionRecords(env.DB, collectionRow.id, limit, url.searchParams.get("cursor"));
        return json({ records: await readProjectRecords(env, project, page.rows, project.owner_id), cursor, nextCursor: page.nextCursor });
      }
      if (!targetId && request.method === "POST") {
        assertProjectWritable(project);
        const body = await readJson(request, MAX_RECORD_BYTES + 1024);
        const encoded = validateRecord(body.data ?? body);
        const id = recordId();
        const now = new Date().toISOString();
        const record = { id, data: JSON.parse(encoded), createdAt: now, updatedAt: now, storage: project.storage_backend || "d1" };
        const mutation = env.DB.prepare("INSERT INTO records (id, collection_id, data_json, drive_file_id, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)")
          .bind(id, collectionRow.id, encoded, now, now);
        const event = { type: "record.created", record };
        const changeDetails = makeChangeDetails(project.id, collectionRow.id, event);
        const payload = { record, driveSync: project.storage_backend === "google_drive" ? "queued" : "not_required" };
        const committed = await commitRecordMutation(env, project.id, project.storage_backend, mutation,
          [id, collection, "upsert", record, null], changeDetails, null, payload, 201);
        if (project.storage_backend === "google_drive") scheduleDriveSync(ctx, env, 4);
        scheduleRealtime(ctx, env, project.id, collection, { ...event, seq: committed.seq, eventId: changeDetails.eventId });
        return json(payload, 201);
      }
      if (targetId && request.method === "GET") {
        const row = await env.DB.prepare("SELECT id, data_json, drive_file_id, created_at, updated_at FROM records WHERE id = ? AND collection_id = ? LIMIT 1")
          .bind(targetId, collectionRow.id).first();
        if (!row) return error("Record not found", 404, "RECORD_NOT_FOUND");
        const records = await readProjectRecords(env, project, [row], project.owner_id);
        return json({ record: records[0] });
      }
      if (targetId && ["PUT", "PATCH"].includes(request.method)) {
        assertProjectWritable(project);
        const body = await readJson(request, MAX_RECORD_BYTES + 1024);
        const current = await env.DB.prepare("SELECT id, data_json, drive_file_id, created_at, updated_at FROM records WHERE id = ? AND collection_id = ? LIMIT 1")
          .bind(targetId, collectionRow.id).first();
        if (!current) return error("Record not found", 404, "RECORD_NOT_FOUND");
        const currentData = JSON.parse(current.data_json);
        let next = body.data ?? body;
        if (request.method === "PATCH") next = { ...currentData, ...next };
        const encoded = validateRecord(next);
        const now = new Date().toISOString();
        const record = { id: targetId, data: JSON.parse(encoded), createdAt: current.created_at, updatedAt: now, storage: project.storage_backend || "d1" };
        const mutation = env.DB.prepare("UPDATE records SET data_json = ?, updated_at = ? WHERE id = ? AND collection_id = ?")
          .bind(encoded, now, targetId, collectionRow.id);
        const event = { type: "record.updated", record };
        const changeDetails = makeChangeDetails(project.id, collectionRow.id, event);
        const payload = { record, driveSync: project.storage_backend === "google_drive" ? "queued" : "not_required" };
        const committed = await commitRecordMutation(env, project.id, project.storage_backend, mutation,
          [targetId, collection, "upsert", record, current.drive_file_id || null], changeDetails, null, payload, 200);
        if (project.storage_backend === "google_drive") scheduleDriveSync(ctx, env, 4);
        scheduleRealtime(ctx, env, project.id, collection, { ...event, seq: committed.seq, eventId: changeDetails.eventId });
        return json(payload);
      }
      if (targetId && request.method === "DELETE") {
        assertProjectWritable(project);
        const current = await env.DB.prepare("SELECT drive_file_id FROM records WHERE id = ? AND collection_id = ? LIMIT 1")
          .bind(targetId, collectionRow.id).first();
        if (!current) return error("Record not found", 404, "RECORD_NOT_FOUND");
        const mutation = env.DB.prepare("DELETE FROM records WHERE id = ? AND collection_id = ?")
          .bind(targetId, collectionRow.id);
        const event = { type: "record.deleted", id: targetId };
        const changeDetails = makeChangeDetails(project.id, collectionRow.id, event);
        const payload = { ok: true, id: targetId, driveSync: project.storage_backend === "google_drive" ? "queued" : "not_required" };
        const committed = await commitRecordMutation(env, project.id, project.storage_backend, mutation,
          [targetId, collection, "delete", null, current.drive_file_id || null], changeDetails, null, payload, 200);
        if (project.storage_backend === "google_drive") scheduleDriveSync(ctx, env, 4);
        scheduleRealtime(ctx, env, project.id, collection, { ...event, seq: committed.seq, eventId: changeDetails.eventId });
        return json(payload);
      }
    }

    if (suffix === "stats" && request.method === "GET") {
      const row = await env.DB.prepare(
        `SELECT (SELECT COUNT(*) FROM collections WHERE project_id = ?) AS collections,
          (SELECT COUNT(*) FROM records r JOIN collections c ON c.id = r.collection_id WHERE c.project_id = ?) AS records,
          (SELECT COUNT(*) FROM api_keys WHERE project_id = ? AND revoked_at IS NULL) AS active_keys`
      ).bind(project.id, project.id, project.id).first();
      return json({ stats: { ...row, storage_backend: project.storage_backend || "d1" } });
    }
  }

  const keyDelete = url.pathname.match(/^\/api\/keys\/([^/]+)$/);
  if (keyDelete && request.method === "DELETE") {
    const result = await env.DB.prepare(
      "UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL AND project_id IN (SELECT id FROM projects WHERE owner_id = ?)"
    ).bind(new Date().toISOString(), keyDelete[1], user.id).run();
    if (!result.meta?.changes) return error("Active API key not found", 404, "KEY_NOT_FOUND");
    return json({ ok: true });
  }

  return error("Dashboard endpoint not found", 404, "NOT_FOUND");
}

async function authenticateApiKey(request, env, project) {
  const header = request.headers.get("Authorization") || "";
  const match = header.match(/^Bearer\s+(ndb_live_[A-Za-z0-9_-]+)$/);
  if (!match) throw new HttpError(401, "A valid VoxyDB API key is required", "API_KEY_REQUIRED");
  const key = match[1];
  const row = await env.DB.prepare(
    `SELECT k.id, k.scopes, k.allowed_origins, p.owner_id, p.storage_backend FROM api_keys k
     JOIN projects p ON p.id = k.project_id
     WHERE k.project_id = ? AND k.key_hash = ? AND k.revoked_at IS NULL LIMIT 1`
  ).bind(project, await sha256(key)).first();
  if (!row) throw new HttpError(401, "API key is invalid or revoked", "API_KEY_INVALID");
  const origins = JSON.parse(row.allowed_origins || "[]");
  const origin = request.headers.get("Origin");
  if (origins.length && origin && !origins.includes(origin)) throw new HttpError(403, "This origin is not allowed for the API key", "ORIGIN_NOT_ALLOWED");
  return row;
}

function checkScope(key, method) {
  const readOnly = ["GET", "HEAD"].includes(method);
  const permitted = key.scopes === "read_write" || (readOnly && key.scopes === "read") || (!readOnly && key.scopes === "write");
  if (!permitted) throw new HttpError(403, "This API key does not have permission for that operation", "INSUFFICIENT_SCOPE");
}

function publicCors(request) {
  const origin = request.headers.get("Origin");
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Idempotency-Key, X-Request-ID",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

async function publicApi(request, env, url, ctx) {
  const cors = publicCors(request);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  const changesRoute = url.pathname.match(/^\/v1\/projects\/([^/]+)\/collections\/([^/]+)\/changes$/);
  if (changesRoute && request.method === "GET") {
    const [, changesProject, rawChangesCollection] = changesRoute;
    const changesCollection = validateCollectionName(decodeURIComponent(rawChangesCollection));
    const key = await authenticateApiKey(request, env, changesProject);
    checkScope(key, "GET");
    const collectionRow = await env.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND name = ? LIMIT 1")
      .bind(changesProject, changesCollection).first();
    if (!collectionRow) return error("Collection not found", 404, "COLLECTION_NOT_FOUND", cors);
    const afterRaw = url.searchParams.get("after") || "0";
    if (!/^\d+$/.test(afterRaw)) return error("The after cursor must be a non-negative integer", 400, "INVALID_CHANGE_CURSOR", cors);
    const after = Number(afterRaw);
    if (!Number.isSafeInteger(after)) return error("The after cursor is too large", 400, "INVALID_CHANGE_CURSOR", cors);
    const limitRaw = url.searchParams.get("limit") || "100";
    if (!/^\d+$/.test(limitRaw)) return error("The limit must be an integer from 1 to 500", 400, "INVALID_LIMIT", cors);
    const limit = Math.min(Math.max(Number(limitRaw), 1), 500);
    const latest = await getCollectionSequence(env.DB, changesProject, collectionRow.id);
    const checkpoint = await env.DB.prepare("SELECT pruned_through_seq FROM change_event_checkpoints WHERE project_id = ? AND collection_id = ? LIMIT 1")
      .bind(changesProject, collectionRow.id).first();
    const prunedThrough = Number(checkpoint?.pruned_through_seq || 0);
    if (after < prunedThrough) {
      return json({ error: { code: "CURSOR_EXPIRED", message: "This change cursor is older than retained history. Fetch a fresh record snapshot and subscribe again." }, snapshotRequired: true, cursor: latest, prunedThroughCursor: prunedThrough }, 410, cors);
    }
    const { results = [] } = await env.DB.prepare(
      `SELECT seq, event_id, event_type, record_id, payload_json, created_at
       FROM change_events WHERE project_id = ? AND collection_id = ? AND seq > ?
       ORDER BY seq ASC LIMIT ?`
    ).bind(changesProject, collectionRow.id, after, limit).all();
    const changes = results.map((row) => ({
      seq: Number(row.seq), eventId: row.event_id, createdAt: row.created_at,
      ...JSON.parse(row.payload_json),
    }));
    return json({ changes, cursor: latest, hasMore: changes.length === limit && changes[changes.length - 1].seq < latest }, 200, cors);
  }

  const realtimeRoute = url.pathname.match(/^\/v1\/projects\/([^/]+)\/collections\/([^/]+)\/(realtime-ticket|realtime)$/);
  if (realtimeRoute) {
    const [, realtimeProject, rawRealtimeCollection, realtimeAction] = realtimeRoute;
    const realtimeCollection = validateCollectionName(decodeURIComponent(rawRealtimeCollection));
    if (realtimeAction === "realtime" && request.method === "GET") {
      return consumeRealtimeTicket(env, request, url);
    }
    if (realtimeAction === "realtime-ticket" && request.method === "POST") {
      const key = await authenticateApiKey(request, env, realtimeProject);
      checkScope(key, "GET");
      const collectionRow = await env.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND name = ? LIMIT 1")
        .bind(realtimeProject, realtimeCollection).first();
      if (!collectionRow) return error("Collection not found", 404, "COLLECTION_NOT_FOUND", cors);
      return json(await createRealtimeTicket(env.DB, realtimeProject, collectionRow.id), 201, cors);
    }
    return error("Method not allowed", 405, "METHOD_NOT_ALLOWED", cors);
  }

  const match = url.pathname.match(/^\/v1\/projects\/([^/]+)\/collections\/([^/]+)\/records(?:\/([^/]+))?$/);
  if (!match) return error("API route not found", 404, "NOT_FOUND", cors);
  const [, project, rawCollection, targetId] = match;
  const collection = validateCollectionName(decodeURIComponent(rawCollection));
  const key = await authenticateApiKey(request, env, project);
  checkScope(key, request.method);
  const collectionRow = await env.DB.prepare("SELECT id FROM collections WHERE project_id = ? AND name = ? LIMIT 1")
    .bind(project, collection).first();
  if (!collectionRow) return json({ error: { code: "COLLECTION_NOT_FOUND", message: "Collection not found" } }, 404, cors);

  if (!targetId && request.method === "GET") {
    const limitRaw = url.searchParams.get("limit") || "50";
    if (!/^\d+$/.test(limitRaw)) return error("The limit must be an integer from 1 to 100", 400, "INVALID_LIMIT", cors);
    const limit = Math.min(Math.max(Number(limitRaw), 1), 100);
    // Read the event high-water mark first. Any concurrent later write will be
    // replayed after this cursor, even if it also appears in the page snapshot.
    const cursor = await getCollectionSequence(env.DB, project, collectionRow.id);
    const page = await listCollectionRecords(env.DB, collectionRow.id, limit, url.searchParams.get("cursor"));
    return json({ records: await readProjectRecords(env, { storage_backend: key.storage_backend || "d1" }, page.rows, key.owner_id), cursor, nextCursor: page.nextCursor }, 200, cors);
  }
  if (!targetId && request.method === "POST") {
    if (key.storage_backend === "migrating") return json({ error: { code: "STORAGE_MIGRATION_IN_PROGRESS", message: "Project storage migration is in progress. Retry after it finishes." } }, 409, cors);
    const body = await readJson(request, MAX_RECORD_BYTES + 1024);
    const idempotency = await prepareIdempotency(env.DB, request, project, collectionRow.id, "POST", url.pathname, body);
    if (idempotency?.replay) return json(idempotency.payload, idempotency.statusCode, { ...cors, "Idempotency-Replayed": "true" });
    const encoded = validateRecord(body.data ?? body);
    const id = recordId();
    const now = new Date().toISOString();
    const record = { id, data: JSON.parse(encoded), createdAt: now, updatedAt: now, storage: key.storage_backend || "d1" };
    const payload = { record, driveSync: key.storage_backend === "google_drive" ? "queued" : "not_required" };
    const event = { type: "record.created", record };
    const changeDetails = makeChangeDetails(project, collectionRow.id, event);
    const mutation = env.DB.prepare("INSERT INTO records (id, collection_id, data_json, drive_file_id, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)")
      .bind(id, collectionRow.id, encoded, now, now);
    const committed = await commitRecordMutation(env, project, key.storage_backend, mutation,
      [id, collection, "upsert", record, null], changeDetails, idempotency, payload, 201);
    if (committed.replay) return json(committed.payload, committed.statusCode, { ...cors, "Idempotency-Replayed": "true" });
    if (key.storage_backend === "google_drive") scheduleDriveSync(ctx, env, 4);
    scheduleRealtime(ctx, env, project, collection, { ...event, seq: committed.seq, eventId: changeDetails.eventId });
    return json(payload, 201, cors);
  }
  if (targetId && request.method === "GET") {
    const row = await env.DB.prepare("SELECT id, data_json, drive_file_id, created_at, updated_at FROM records WHERE id = ? AND collection_id = ? LIMIT 1")
      .bind(targetId, collectionRow.id).first();
    if (!row) return json({ error: { code: "RECORD_NOT_FOUND", message: "Record not found" } }, 404, cors);
    const records = await readProjectRecords(env, { storage_backend: key.storage_backend || "d1" }, [row], key.owner_id);
    return json({ record: records[0] }, 200, cors);
  }
  if (targetId && ["PUT", "PATCH"].includes(request.method)) {
    if (key.storage_backend === "migrating") return json({ error: { code: "STORAGE_MIGRATION_IN_PROGRESS", message: "Project storage migration is in progress. Retry after it finishes." } }, 409, cors);
    const body = await readJson(request, MAX_RECORD_BYTES + 1024);
    const idempotency = await prepareIdempotency(env.DB, request, project, collectionRow.id, request.method, url.pathname, body);
    if (idempotency?.replay) return json(idempotency.payload, idempotency.statusCode, { ...cors, "Idempotency-Replayed": "true" });
    const current = await env.DB.prepare("SELECT id, data_json, drive_file_id, created_at, updated_at FROM records WHERE id = ? AND collection_id = ? LIMIT 1")
      .bind(targetId, collectionRow.id).first();
    if (!current) return json({ error: { code: "RECORD_NOT_FOUND", message: "Record not found" } }, 404, cors);
    const currentData = JSON.parse(current.data_json);
    let next = body.data ?? body;
    if (request.method === "PATCH") next = { ...currentData, ...next };
    const encoded = validateRecord(next);
    const now = new Date().toISOString();
    const record = { id: targetId, data: JSON.parse(encoded), createdAt: current.created_at, updatedAt: now, storage: key.storage_backend || "d1" };
    const payload = { record, driveSync: key.storage_backend === "google_drive" ? "queued" : "not_required" };
    const event = { type: "record.updated", record };
    const changeDetails = makeChangeDetails(project, collectionRow.id, event);
    const mutation = env.DB.prepare("UPDATE records SET data_json = ?, updated_at = ? WHERE id = ? AND collection_id = ?")
      .bind(encoded, now, targetId, collectionRow.id);
    const committed = await commitRecordMutation(env, project, key.storage_backend, mutation,
      [targetId, collection, "upsert", record, current.drive_file_id || null], changeDetails, idempotency, payload, 200);
    if (committed.replay) return json(committed.payload, committed.statusCode, { ...cors, "Idempotency-Replayed": "true" });
    if (key.storage_backend === "google_drive") scheduleDriveSync(ctx, env, 4);
    scheduleRealtime(ctx, env, project, collection, { ...event, seq: committed.seq, eventId: changeDetails.eventId });
    return json(payload, 200, cors);
  }
  if (targetId && request.method === "DELETE") {
    if (key.storage_backend === "migrating") return json({ error: { code: "STORAGE_MIGRATION_IN_PROGRESS", message: "Project storage migration is in progress. Retry after it finishes." } }, 409, cors);
    const idempotency = await prepareIdempotency(env.DB, request, project, collectionRow.id, "DELETE", url.pathname, null);
    if (idempotency?.replay) return json(idempotency.payload, idempotency.statusCode, { ...cors, "Idempotency-Replayed": "true" });
    const current = await env.DB.prepare("SELECT drive_file_id FROM records WHERE id = ? AND collection_id = ? LIMIT 1")
      .bind(targetId, collectionRow.id).first();
    if (!current) return json({ error: { code: "RECORD_NOT_FOUND", message: "Record not found" } }, 404, cors);
    const payload = { ok: true, id: targetId, driveSync: key.storage_backend === "google_drive" ? "queued" : "not_required" };
    const event = { type: "record.deleted", id: targetId };
    const changeDetails = makeChangeDetails(project, collectionRow.id, event);
    const mutation = env.DB.prepare("DELETE FROM records WHERE id = ? AND collection_id = ?")
      .bind(targetId, collectionRow.id);
    const committed = await commitRecordMutation(env, project, key.storage_backend, mutation,
      [targetId, collection, "delete", null, current.drive_file_id || null], changeDetails, idempotency, payload, 200);
    if (committed.replay) return json(committed.payload, committed.statusCode, { ...cors, "Idempotency-Replayed": "true" });
    if (key.storage_backend === "google_drive") scheduleDriveSync(ctx, env, 4);
    scheduleRealtime(ctx, env, project, collection, { ...event, seq: committed.seq, eventId: changeDetails.eventId });
    return json(payload, 200, cors);
  }
  return error("Method not allowed", 405, "METHOD_NOT_ALLOWED", cors);
}

export default {
  async scheduled(controller, env, ctx) {
    await processDriveSyncJobs(env, 20);
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/v1/")) return await publicApi(request, env, url, ctx);
      if (url.pathname.startsWith("/api/")) return await dashboardApi(request, env, url, ctx);
      const assetResponse = await env.ASSETS.fetch(request);
      const headers = new Headers(assetResponse.headers);
      headers.set("X-Content-Type-Options", "nosniff");
      headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
      headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
      headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' wss: https://oauth2.googleapis.com https://www.googleapis.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
      return new Response(assetResponse.body, { status: assetResponse.status, statusText: assetResponse.statusText, headers });
    } catch (err) {
      if (err instanceof HttpError) return error(err.message, err.status, err.code, url.pathname.startsWith("/v1/") ? publicCors(request) : {});
      if (err instanceof DriveApiError) return error(err.message, err.status, err.code, url.pathname.startsWith("/v1/") ? publicCors(request) : {});
      console.error("VoxyDB request failed:", err);
      return error("An unexpected server error occurred", 500, "INTERNAL_ERROR");
    }
  },
};

export { RealtimeHub, getPublicOrigin, requireSameOrigin };
