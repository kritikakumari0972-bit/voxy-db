const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";

export class DriveApiError extends Error {
  constructor(status, message, code = "DRIVE_API_ERROR") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function encryptionKey(secret) {
  if (!secret || secret.length < 32) {
    throw new DriveApiError(503, "DRIVE_TOKEN_ENCRYPTION_KEY is not configured (use a random secret of at least 32 characters)", "DRIVE_ENCRYPTION_NOT_CONFIGURED");
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptRefreshToken(value, secret) {
  const key = await encryptionKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(value));
  return `v1.${base64url(iv)}.${base64url(new Uint8Array(encrypted))}`;
}

export async function decryptRefreshToken(value, secret) {
  const parts = String(value || "").split(".");
  if (parts.length !== 3 || parts[0] !== "v1") throw new DriveApiError(500, "Stored Drive connection token has an unsupported format", "DRIVE_TOKEN_FORMAT_INVALID");
  try {
    const key = await encryptionKey(secret);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64url(parts[1]) }, key, fromBase64url(parts[2]));
    return new TextDecoder().decode(decrypted);
  } catch (cause) {
    if (cause instanceof DriveApiError) throw cause;
    throw new DriveApiError(500, "Could not decrypt the stored Drive connection. Check the encryption secret.", "DRIVE_TOKEN_DECRYPT_FAILED");
  }
}

async function requestWithRetry(url, options, label) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response;
    try {
      response = await fetch(url, options);
    } catch {
      lastError = new DriveApiError(503, "Google Drive could not be reached. Try again shortly.", "DRIVE_UNAVAILABLE");
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt)));
      continue;
    }
    if (response.ok) return response;
    const text = await response.text();
    let detail = "";
    try { detail = JSON.parse(text)?.error?.message || ""; } catch { /* non-JSON upstream error */ }
    const retryable = response.status === 429 || response.status === 500 || response.status === 502 || response.status === 503 || response.status === 504;
    const mappedStatus = [401, 403, 404, 429].includes(response.status) ? response.status : 503;
    const mappedCode = response.status === 401 ? "DRIVE_REAUTH_REQUIRED"
      : response.status === 403 ? "DRIVE_ACCESS_DENIED"
        : response.status === 404 ? "DRIVE_FILE_NOT_FOUND"
          : response.status === 429 ? "DRIVE_RATE_LIMITED" : "DRIVE_UPSTREAM_ERROR";
    lastError = new DriveApiError(
      mappedStatus,
      detail ? `Google Drive ${label} failed: ${detail}` : `Google Drive ${label} failed (${response.status})`,
      mappedCode,
    );
    if (!retryable || attempt === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt)));
  }
  throw lastError || new DriveApiError(503, "Google Drive request failed", "DRIVE_UPSTREAM_ERROR");
}

export async function refreshDriveAccessToken(env, encryptedRefreshToken) {
  const refreshToken = await decryptRefreshToken(encryptedRefreshToken, env.DRIVE_TOKEN_ENCRYPTION_KEY);
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    if (data.error === "invalid_grant") {
      throw new DriveApiError(401, "Google Drive authorization expired or was revoked. Reconnect Google Drive.", "DRIVE_REAUTH_REQUIRED");
    }
    throw new DriveApiError(503, "Could not refresh the Google Drive access token", "DRIVE_TOKEN_REFRESH_FAILED");
  }
  return data.access_token;
}

export async function verifyDriveRootFolder(accessToken, folderId) {
  const response = await requestWithRetry(`${DRIVE_API}/files/${encodeURIComponent(folderId)}?fields=id,name,mimeType,trashed`, {
    headers: { authorization: `Bearer ${accessToken}` },
  }, "storage-folder verification");
  const folder = await response.json();
  if (folder.trashed || folder.mimeType !== "application/vnd.google-apps.folder") {
    throw new DriveApiError(409, "The connected Drive storage folder is unavailable or is no longer a folder", "DRIVE_ROOT_FOLDER_INVALID");
  }
  return folder;
}

export async function createDriveRootFolder(accessToken) {
  const response = await requestWithRetry(`${DRIVE_API}/files?fields=id,name,mimeType`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "VoxyDB", mimeType: "application/vnd.google-apps.folder", appProperties: { app: "VoxyDB", kind: "root" } }),
  }, "folder creation");
  const folder = await response.json();
  if (!folder.id) throw new DriveApiError(502, "Google Drive did not return a folder ID", "DRIVE_FOLDER_CREATE_FAILED");
  return folder;
}

export async function findDriveRecordFile(accessToken, rootFolderId, recordId) {
  const query = `'${rootFolderId}' in parents and appProperties has { key='recordId' and value='${recordId}' } and trashed=false`;
  const url = `${DRIVE_API}/files?q=${encodeURIComponent(query)}&pageSize=1&fields=files(id,name)`;
  const response = await requestWithRetry(url, { headers: { authorization: `Bearer ${accessToken}` } }, "record lookup");
  const payload = await response.json();
  return payload.files?.[0] || null;
}

export async function createDriveRecordFile(accessToken, rootFolderId, projectId, collectionName, record) {
  const boundary = `voxydb_${base64url(crypto.getRandomValues(new Uint8Array(12)))}`;
  const metadata = {
    name: `${projectId}__${collectionName}__${record.id}.json`,
    mimeType: "application/json",
    parents: [rootFolderId],
    appProperties: { app: "VoxyDB", projectId, collection: collectionName, recordId: record.id },
  };
  const content = JSON.stringify(record);
  const body = [
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${content}\r\n`,
    `--${boundary}--`,
  ].join("");
  const response = await requestWithRetry(`${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,name,mimeType,modifiedTime`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": `multipart/related; boundary=${boundary}` },
    body,
  }, "record creation");
  const file = await response.json();
  if (!file.id) throw new DriveApiError(502, "Google Drive did not return a file ID", "DRIVE_FILE_CREATE_FAILED");
  return file;
}

export async function updateDriveRecordFile(accessToken, fileId, record) {
  await requestWithRetry(`${DRIVE_UPLOAD_API}/files/${encodeURIComponent(fileId)}?uploadType=media`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json; charset=UTF-8" },
    body: JSON.stringify(record),
  }, "record update");
}

export async function readDriveRecordFile(accessToken, fileId) {
  const response = await requestWithRetry(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`, {
    headers: { authorization: `Bearer ${accessToken}` },
  }, "record read");
  const text = await response.text();
  try {
    const record = JSON.parse(text);
    if (!record || typeof record !== "object" || Array.isArray(record) || typeof record.data !== "object" || record.data === null || Array.isArray(record.data)) {
      throw new Error("invalid record shape");
    }
    return record;
  } catch {
    throw new DriveApiError(502, "A VoxyDB record file in Google Drive contains invalid JSON", "DRIVE_RECORD_CORRUPT");
  }
}

export async function deleteDriveRecordFile(accessToken, fileId) {
  await requestWithRetry(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${accessToken}` },
  }, "record deletion");
}
