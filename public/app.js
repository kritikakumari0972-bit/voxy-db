const state = { user: null, projects: [], project: null, page: "overview", collections: [], collection: null, records: [], editingRecordId: null, oneTimeKey: null, realtimeSocket: null, realtimeKey: null, realtimeRetry: null, recordsRenderRequest: 0 };
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function toast(message, isError = false) {
  const region = $("#toast-region");
  region.innerHTML = `<div class="toast ${isError ? "error" : ""}">${escapeHtml(message)}</div>`;
  setTimeout(() => { region.innerHTML = ""; }, 3200);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) },
  });
  const payload = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && path !== "/api/me") {
      state.user = null;
      renderLogin();
    }
    throw new Error(payload.error?.message || `Request failed (${response.status})`);
  }
  return payload;
}

function jsonBody(value) { return JSON.stringify(value); }
function projectLabel(project) { return project?.name || "Select a project"; }
function initials(name) { return String(name || "N").split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase(); }
function showDialog(id) { const dialog = document.getElementById(id); if (dialog?.showModal) dialog.showModal(); }
function closeDialog(id) { const dialog = document.getElementById(id); if (dialog?.open) dialog.close(); }

function renderLogin(message = "") {
  closeDashboardRealtime();
  const queryError = new URLSearchParams(location.search).get("auth_error");
  const visibleMessage = message || (queryError ? "Google sign-in could not be completed. Please try again." : "");
  if (queryError) history.replaceState({}, "", location.pathname);
  $("#app").innerHTML = `
    <div class="login-wrap">
      <section class="login-story">
        <div class="brand-row"><div class="brand-mark">N</div><span>VoxyDB</span></div>
        <h1>Your app's data.<br><span class="gradient-text">Always live.</span></h1>
        <p>A real-time database service for apps and websites. Store JSON records, organise collections, and connect projects through a REST API.</p>
        <div class="feature-pills"><span class="pill">⌁ Persistent database</span><span class="pill">↗ REST API</span><span class="pill">◈ Project keys</span><span class="pill">◫ Drive mirror</span><span class="pill">⇄ Live sync</span></div>
      </section>
      <section class="login-card">
        <div class="eyebrow">DATABASE WORKSPACE</div>
        <h2>Welcome to VoxyDB</h2>
        <p>Sign in with Google to manage your databases and API projects. Your Google password is never shared with VoxyDB.</p>
        ${visibleMessage ? `<div class="status-error">${escapeHtml(visibleMessage)}</div>` : ""}
        <button class="google-button" id="google-signin"><span class="google-g">G</span> Continue with Google</button>
        <div class="login-note">Google Sign-In secures your VoxyDB account. Google Drive authorization is a separate optional step used only for database storage and backup.</div>
      </section>
    </div>`;
  $("#google-signin").addEventListener("click", () => { location.href = "/api/auth/google/start"; });
}

function renderShell() {
  const pButtons = state.projects.map((project) => `
    <button class="project-button ${state.project?.id === project.id ? "active" : ""}" data-project="${escapeHtml(project.id)}">
      <span class="project-dot"></span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(project.name)}</span>
    </button>`).join("");
  $("#app").innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand-row"><div class="brand-mark">N</div><span>VoxyDB</span></div>
        <div class="brand-caption">Database control</div>
        <nav class="side-nav">
          <button class="nav-button ${state.page === "overview" ? "active" : ""}" data-page="overview"><span class="nav-icon">⌂</span>Overview</button>
          <button class="nav-button ${state.page === "collections" ? "active" : ""}" data-page="collections"><span class="nav-icon">▤</span>Collections</button>
          <button class="nav-button ${state.page === "keys" ? "active" : ""}" data-page="keys"><span class="nav-icon">⚿</span>API keys</button>
          <button class="nav-button ${state.page === "docs" ? "active" : ""}" data-page="docs"><span class="nav-icon">⌘</span>API docs</button>
          <button class="nav-button ${state.page === "storage" ? "active" : ""}" data-page="storage"><span class="nav-icon">◫</span>Storage</button>
        </nav>
        <div class="side-divider"></div>
        <div class="project-heading"><span>Projects</span><button class="tiny-add" id="open-project" title="New project">+</button></div>
        <div class="project-list">${pButtons || `<div class="small-muted" style="padding:8px 10px">No projects yet</div>`}</div>
        <div class="sidebar-bottom"><div class="eyebrow">VOXY CLOUD</div><p>Persistent database + optional Google Drive file storage. Provider limits apply. Keep private keys out of client apps.</p></div>
      </aside>
      <section class="main-area">
        <header class="topbar">
          <div class="breadcrumb">Workspace <span style="color:#53647e;padding:0 7px">/</span><strong>${escapeHtml(projectLabel(state.project))}</strong></div>
          <div class="top-actions"><div class="status-live"><span class="status-dot"></span> Cloud workspace</div><div class="user-chip"><div class="avatar">${escapeHtml(initials(state.user?.display_name))}</div><span>${escapeHtml(state.user?.display_name || state.user?.email || "Google user")}</span></div><button class="button small ghost" id="signout">Sign out</button></div>
        </header>
        <main class="content" id="view"></main>
      </section>
    </div>`;
  $$("[data-page]").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.page)));
  $$("[data-project]").forEach((button) => button.addEventListener("click", () => selectProject(button.dataset.project)));
  $("#open-project").addEventListener("click", () => showDialog("project-dialog"));
  $("#signout").addEventListener("click", signOut);
  renderPage();
}

function navigate(page) {
  closeDashboardRealtime();
  if (page !== "keys") state.oneTimeKey = null;
  state.page = page;
  state.collection = null;
  renderShell();
}

async function loadProjects() {
  const result = await api("/api/projects");
  state.projects = result.projects || [];
  if (state.project && !state.projects.some((p) => p.id === state.project.id)) state.project = null;
  if (!state.project && state.projects.length) state.project = state.projects[0];
}

async function selectProject(id) {
  closeDashboardRealtime();
  state.project = state.projects.find((project) => project.id === id) || null;
  state.collection = null;
  state.page = "overview";
  renderShell();
}

function pageHeader(eyebrow, title, subtitle, button = "") {
  return `<div class="page-head"><div><div class="eyebrow">${escapeHtml(eyebrow)}</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p></div>${button}</div>`;
}

async function renderPage() {
  const view = $("#view");
  if (state.page === "storage") {
    await renderStorage(view);
    return;
  }
  if (!state.projects.length) {
    view.innerHTML = `${pageHeader("GET STARTED", "Create your first project", "Projects keep your collections, records and API keys organised.")}
      <div class="empty-state"><div class="empty-icon">✦</div><h3>Your database workspace is ready</h3><p>Create a project to get a project ID, add collections, and start saving real JSON records.</p><button class="button primary" id="empty-create-project">＋ Create your first project</button></div>`;
    $("#empty-create-project").addEventListener("click", () => showDialog("project-dialog"));
    return;
  }
  if (!state.project) { view.innerHTML = `<div class="empty-state">Choose a project from the sidebar.</div>`; return; }
  if (state.page === "overview") await renderOverview(view);
  else if (state.page === "collections") await renderCollections(view);
  else if (state.page === "keys") await renderKeys(view);
  else if (state.page === "docs") renderDocs(view);
  else if (state.page === "storage") await renderStorage(view);
}

async function renderStorage(view) {
  let connection;
  let projectStorage = null;
  try {
    connection = await api("/api/drive/connection");
    if (state.project) projectStorage = (await api(`/api/projects/${encodeURIComponent(state.project.id)}/storage`)).storage;
  } catch (err) {
    view.innerHTML = `${pageHeader("STORAGE", "Storage engine", "Connect Google Drive to create and maintain a mirror of your database records.")}
      <div class="status-error">${escapeHtml(err.message)}</div>`;
    return;
  }

  const driveConnected = projectStorage?.driveConnected ?? connection.connected;
  const connectedPanel = driveConnected
    ? `<div class="drive-account"><div class="drive-symbol">G</div><div><strong>Google Drive storage ready</strong><span>Authorized for VoxyDB database files</span><small>Connected ${escapeHtml(connection.connectedAt ? new Date(connection.connectedAt).toLocaleString() : "")}</small></div><a class="button small ghost" href="/api/drive/connect">Reconnect</a>${connection.connected && connection.canDisconnect ? `<button class="button small danger" id="disconnect-drive">Disconnect</button>` : ""}<span class="connection-badge">Connected</span></div>`
    : `<div class="drive-account disconnected"><div class="drive-symbol">G</div><div><strong>Google Drive storage not connected</strong><span>Authorize VoxyDB to create and manage only the database files it creates.</span><small>Your other Drive files are not included in this permission.</small></div><a class="button primary" href="/api/drive/connect">Connect Google Drive</a></div>`;

  let projectPanel = `<div class="empty-state"><div class="empty-icon">◫</div><h3>Create a project first</h3><p>Choose a project to select its live storage engine.</p></div>`;
  if (projectStorage) {
    const backend = projectStorage.backend;
    const backendName = backend === "google_drive" ? "D1 + Google Drive mirror" : backend === "migrating" ? "Drive mirror setup in progress" : "Cloudflare D1";
    const progress = projectStorage.totalRecords ? Math.round((projectStorage.driveBackedRecords / projectStorage.totalRecords) * 100) : (backend === "google_drive" ? 100 : 0);
    let action = "";
    if (!driveConnected) {
      action = `<button class="button primary" disabled>Connect Drive first</button>`;
    } else if (backend === "google_drive") {
      action = `<button class="button danger" id="use-d1">Switch live storage to D1</button>`;
    } else {
      action = `<button class="button primary" id="migrate-drive">${backend === "migrating" ? "Continue mirror setup" : "Enable Google Drive mirror"}</button>`;
    }
    projectPanel = `<div class="panel storage-project"><div class="storage-topline"><div><div class="eyebrow">${escapeHtml(state.project.name)}</div><h3>Storage mode: ${escapeHtml(backendName)}</h3><p class="docs-copy">${backend === "google_drive" ? "D1 commits every record immediately. A durable retry queue automatically mirrors the committed record to a JSON file in Google Drive; temporary Drive outages do not lose the database write." : backend === "migrating" ? "Record writes are temporarily paused while existing records are copied to Drive. Continue the migration until it reaches 100%." : "This project currently stores live records in Cloudflare D1. Existing records will be copied to Drive before switching the live API."}</p></div><span class="storage-tag ${backend === "google_drive" ? "good" : backend === "migrating" ? "working" : ""}">${escapeHtml(backend.toUpperCase().replaceAll("_", " "))}</span></div>
      <div class="storage-metrics"><div><span>Records in project</span><strong>${Number(projectStorage.totalRecords || 0).toLocaleString()}</strong></div><div><span>Drive files linked</span><strong>${Number(projectStorage.driveBackedRecords || 0).toLocaleString()}</strong></div><div><span>Drive sync pending</span><strong>${Number(projectStorage.syncPending || 0).toLocaleString()}</strong></div></div>
      <div class="progress-track"><span style="width:${progress}%"></span></div>
      <div class="storage-actions">${action}<span class="small-muted">${backend === "google_drive" ? (Number(projectStorage.syncPending || 0) ? `Automatic sync is retrying ${Number(projectStorage.syncPending)} pending item(s).` : "All queued Drive copies are up to date.") : "25 records per batch · Keep this page open during initial setup."}</span></div></div>`;
  }

  view.innerHTML = `${pageHeader("STORAGE ENGINE", "Google Drive storage", "Keep a second copy of database record files in your connected Google Drive.")}
    <section class="panel"><div class="panel-head"><div><h3>Drive storage permission</h3><p>Google Sign-In secures your VoxyDB account. Google Drive uses a separate, limited permission only when you choose Drive storage.</p></div></div>${connectedPanel}
      <div class="storage-explain"><strong>What VoxyDB stores</strong><p>VoxyDB creates a folder named <code>VoxyDB</code> and one JSON mirror file for each record. D1 remains the immediate primary database; every record change is placed in a persistent outbox and mirrored to Drive automatically, with retries when Drive is temporarily unavailable.</p></div>
    </section>
    ${projectPanel}
    <section class="panel"><div class="panel-head"><div><h3>Important engineering details</h3><p>Understand how Drive-backed mode behaves before using it for an app.</p></div></div>
      <div class="storage-facts"><div><strong>Drive is file storage</strong><p>It is not a SQL server. VoxyDB provides the database API and uses D1 for the index, metadata and recovery cache.</p></div><div><strong>Consistency and latency</strong><p>D1 commits first, then a durable outbox mirrors the change to Drive and retries failures automatically. Connected apps receive WebSocket events after commit; manual edits made directly in Drive are not imported back.</p></div><div><strong>Your storage quota</strong><p>Files count against the connected Google account's available Drive storage. Google API quotas and rate limits also apply.</p></div><div><strong>Disconnect safety</strong><p>Do not revoke Drive access while a project uses Drive mode. Switch the project back to D1 first. The Drive files are not automatically deleted when switching back.</p></div></div>
    </section>`;

  $("#disconnect-drive")?.addEventListener("click", async () => {
    if (!confirm("Disconnect Google Drive storage from this VoxyDB instance? Switch every project using this Drive back to D1 first.")) return;
    try {
      await api("/api/drive/disconnect", { method: "POST", body: "{}" });
      toast("Drive storage disconnected");
      await renderStorage($("#view"));
    } catch (err) { toast(err.message, true); }
  });

  $("#migrate-drive")?.addEventListener("click", async () => {
    const button = $("#migrate-drive");
    button.disabled = true;
    let totalMigrated = 0;
    try {
      let remaining = Number(projectStorage.totalRecords || 0) - Number(projectStorage.driveBackedRecords || 0);
      let batches = 0;
      while (remaining > 0 || batches === 0) {
        const result = await api(`/api/projects/${encodeURIComponent(state.project.id)}/storage/migrate`, { method: "POST", body: "{}" });
        totalMigrated += Number(result.migrated || 0);
        remaining = Number(result.remaining || 0);
        batches += 1;
        button.textContent = `Copied ${totalMigrated} · ${remaining} remaining`;
        if (remaining === 0 || batches >= 20) break;
      }
      toast(remaining === 0 ? "Google Drive mirror enabled" : `Copied ${totalMigrated} records. Press Continue mirror setup for the rest.`);
      await renderStorage($("#view"));
    } catch (err) {
      toast(err.message, true);
      await renderStorage($("#view"));
    }
  });

  $("#use-d1")?.addEventListener("click", async () => {
    if (!confirm("Switch this project's live API back to Cloudflare D1? Google Drive files will be kept as copies.")) return;
    try {
      await api(`/api/projects/${encodeURIComponent(state.project.id)}/storage/use-d1`, { method: "POST", body: "{}" });
      toast("Live storage switched to D1. Drive files were retained.");
      await renderStorage($("#view"));
    } catch (err) { toast(err.message, true); }
  });
}

async function renderOverview(view) {
  const [statsResult, collectionsResult, health] = await Promise.all([
    api(`/api/projects/${encodeURIComponent(state.project.id)}/stats`),
    api(`/api/projects/${encodeURIComponent(state.project.id)}/collections`),
    api("/api/health"),
  ]);
  state.collections = collectionsResult.collections || [];
  const stats = statsResult.stats || {};
  const collectionCards = state.collections.slice(0, 6).map((item) => `
    <button class="collection-card" data-open-collection="${escapeHtml(item.name)}"><div class="collection-name">▤ ${escapeHtml(item.name)}</div><div class="collection-meta">${Number(item.record_count || 0)} records · Created ${escapeHtml(new Date(item.created_at).toLocaleDateString())}</div></button>`).join("");
  view.innerHTML = `${pageHeader("PROJECT OVERVIEW", state.project.name, "Your live database at a glance.", `<button class="button primary" id="overview-add-collection">＋ New collection</button>`)}
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-label">Collections</div><div class="stat-value">${Number(stats.collections || 0)}</div><div class="stat-foot">Data groups in this project</div></div>
      <div class="stat-card"><div class="stat-label">Records</div><div class="stat-value">${Number(stats.records || 0)}</div><div class="stat-foot">Persistent JSON documents</div></div>
      <div class="stat-card"><div class="stat-label">Active API keys</div><div class="stat-value">${Number(stats.active_keys || 0)}</div><div class="stat-foot">Manage project access</div></div>
      <div class="stat-card"><div class="stat-label">Database status</div><div class="stat-value" style="font-size:20px;color:#72e0bf">${health.database === "connected" ? "Connected" : "Checking"}</div><div class="stat-foot">Cloud database reachable</div></div>
    </div>
    <div class="grid-two">
      <section class="panel"><div class="panel-head"><div><h3>Your collections</h3><p>Organise your app data into named groups.</p></div><button class="button small ghost" id="view-all-collections">View all ↗</button></div>
        ${collectionCards ? `<div class="collection-grid">${collectionCards}</div>` : `<div class="empty-state"><div class="empty-icon">▤</div><h3>No collections yet</h3><p>Create your first collection, such as <code>users</code>, <code>posts</code> or <code>orders</code>.</p><button class="button primary" id="first-collection">Create collection</button></div>`}
      </section>
      <section class="panel"><div class="panel-head"><div><h3>Connect your app</h3><p>Use your project ID and an API key to send data.</p></div></div>
        <div class="docs-code">Project ID\n${escapeHtml(state.project.id)}\n\nREST endpoint\n${escapeHtml(location.origin)}/v1/projects/${escapeHtml(state.project.id)}/collections/YOUR_COLLECTION/records</div>
        <p class="docs-copy">Create a read-only key for public client apps. Keep write keys on a trusted server. Visit API keys to manage access.</p><button class="button small" id="go-keys">Manage API keys ↗</button>
      </section>
    </div>`;
  $("#overview-add-collection")?.addEventListener("click", () => showDialog("collection-dialog"));
  $("#first-collection")?.addEventListener("click", () => showDialog("collection-dialog"));
  $("#view-all-collections")?.addEventListener("click", () => navigate("collections"));
  $("#go-keys")?.addEventListener("click", () => navigate("keys"));
  $$('[data-open-collection]').forEach((button) => button.addEventListener("click", () => openCollection(button.dataset.openCollection)));
}

async function renderCollections(view) {
  const result = await api(`/api/projects/${encodeURIComponent(state.project.id)}/collections`);
  state.collections = result.collections || [];
  if (state.collection) {
    await renderRecords(view);
    return;
  }
  const cards = state.collections.map((item) => `
    <button class="collection-card" data-open-collection="${escapeHtml(item.name)}"><div class="collection-name">▤ ${escapeHtml(item.name)}</div><div class="collection-meta">${Number(item.record_count || 0)} records · ${escapeHtml(item.id)}</div></button>`).join("");
  view.innerHTML = `${pageHeader("DATA", "Collections", "Each collection holds JSON records for one data type.", `<button class="button primary" id="collections-add">＋ New collection</button>`)}
    ${cards ? `<div class="collection-grid">${cards}</div>` : `<div class="empty-state"><div class="empty-icon">▤</div><h3>No collections created</h3><p>Collections are similar to tables. Use names like <code>customers</code>, <code>messages</code> or <code>game_stats</code>.</p><button class="button primary" id="collections-first">Create collection</button></div>`}`;
  $("#collections-add")?.addEventListener("click", () => showDialog("collection-dialog"));
  $("#collections-first")?.addEventListener("click", () => showDialog("collection-dialog"));
  $$('[data-open-collection]').forEach((button) => button.addEventListener("click", () => openCollection(button.dataset.openCollection)));
}

async function openCollection(name) {
  if (state.collection !== name) closeDashboardRealtime();
  state.collection = name;
  state.page = "collections";
  const view = $("#view");
  view.innerHTML = `<div class="small-muted">Loading collection…</div>`;
  await renderRecords(view);
}

function closeDashboardRealtime() {
  state.recordsRenderRequest += 1;
  if (state.realtimeRetry) clearTimeout(state.realtimeRetry);
  state.realtimeRetry = null;
  if (state.realtimeSocket) {
    try { state.realtimeSocket.close(1000, "Dashboard view changed"); } catch { /* already closed */ }
  }
  state.realtimeSocket = null;
  state.realtimeKey = null;
}

async function connectDashboardRealtime() {
  if (!state.project || !state.collection) return;
  const key = `${state.project.id}:${state.collection}`;
  if (state.realtimeKey === key && state.realtimeSocket && state.realtimeSocket.readyState < 2) return;
  closeDashboardRealtime();
  state.realtimeKey = key;
  let retryDelay = 1500;
  const connect = async () => {
    if (state.realtimeKey !== key) return;
    try {
      const result = await api(`/api/projects/${encodeURIComponent(state.project.id)}/collections/${encodeURIComponent(state.collection)}/realtime-ticket`, { method: "POST", body: "{}" });
      const wsUrl = new URL(`/v1/projects/${encodeURIComponent(state.project.id)}/collections/${encodeURIComponent(state.collection)}/realtime`, location.href);
      wsUrl.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      wsUrl.searchParams.set("ticket", result.ticket);
      const socket = new WebSocket(wsUrl);
      state.realtimeSocket = socket;
      socket.addEventListener("open", () => {
        retryDelay = 1500;
        // The socket is live before we refresh the snapshot, closing the gap
        // between the first page load and subscription establishment.
        if (state.realtimeKey === key && state.page === "collections") {
          renderRecords($("#view")).catch((err) => toast(err.message, true));
        }
      });
      socket.addEventListener("message", (event) => {
        let payload;
        try { payload = JSON.parse(event.data); } catch { return; }
        if (["record.created", "record.updated", "record.deleted"].includes(payload.type) && state.realtimeKey === key && state.page === "collections") {
          renderRecords($("#view")).catch((err) => toast(err.message, true));
        }
      });
      socket.addEventListener("close", () => {
        if (state.realtimeKey !== key) return;
        state.realtimeRetry = setTimeout(connect, retryDelay);
        retryDelay = Math.min(30000, retryDelay * 2);
      }, { once: true });
      socket.addEventListener("error", () => { try { socket.close(); } catch { /* closed */ } });
    } catch {
      if (state.realtimeKey !== key) return;
      state.realtimeRetry = setTimeout(connect, retryDelay);
      retryDelay = Math.min(30000, retryDelay * 2);
    }
  };
  await connect();
}

async function renderRecords(view) {
  const requestId = ++state.recordsRenderRequest;
  const result = await api(`/api/projects/${encodeURIComponent(state.project.id)}/collections/${encodeURIComponent(state.collection)}/records?limit=100`);
  if (requestId !== state.recordsRenderRequest || view !== $("#view") || state.page !== "collections") return;
  state.records = result.records || [];
  const rows = state.records.map((record) => {
    const preview = JSON.stringify(record.data);
    return `<tr><td class="mono">${escapeHtml(record.id)}</td><td><div class="record-preview mono">${escapeHtml(preview)}</div></td><td>${escapeHtml(new Date(record.updatedAt).toLocaleString())}</td><td><div class="table-actions"><button class="button small" data-edit-record="${escapeHtml(record.id)}">Edit</button><button class="button small danger" data-delete-record="${escapeHtml(record.id)}">Delete</button></div></td></tr>`;
  }).join("");
  view.innerHTML = `${pageHeader("COLLECTION", state.collection, `${state.records.length} records loaded · Live updates enabled · Maximum 100 shown`, `<button class="button primary" id="add-record">＋ Add record</button>`)}
    <div class="panel"><div class="panel-head"><div><h3>Records</h3><p>Committed changes sync to subscribed apps and dashboard sessions. Drive-backed projects mirror records automatically in the background.</p></div><button class="button small ghost" id="back-collections">← All collections</button></div>
      ${rows ? `<div class="table-wrap"><table><thead><tr><th>Record ID</th><th>Data preview</th><th>Updated</th><th style="text-align:right">Actions</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty-state"><div class="empty-icon">{ }</div><h3>This collection is empty</h3><p>Add a JSON record now. It will be saved in the live database.</p><button class="button primary" id="empty-add-record">Add first record</button></div>`}
    </div>`;
  $("#add-record")?.addEventListener("click", () => openRecordEditor(null));
  $("#empty-add-record")?.addEventListener("click", () => openRecordEditor(null));
  $("#back-collections")?.addEventListener("click", () => { state.collection = null; renderPage(); });
  $$('[data-edit-record]').forEach((button) => button.addEventListener("click", () => openRecordEditor(button.dataset.editRecord)));
  $$('[data-delete-record]').forEach((button) => button.addEventListener("click", () => deleteRecord(button.dataset.deleteRecord)));
  await connectDashboardRealtime();
}

function openRecordEditor(id) {
  state.editingRecordId = id;
  const record = id ? state.records.find((item) => item.id === id) : null;
  $("#record-dialog-title").textContent = record ? "Edit record" : "Add record";
  $("#record-eyebrow").textContent = `${state.collection} · JSON DOCUMENT`;
  $("#record-json").value = JSON.stringify(record?.data || { name: "Example", active: true }, null, 2);
  showDialog("record-dialog");
}

async function deleteRecord(id) {
  if (!confirm("Delete this record permanently?")) return;
  try {
    await api(`/api/projects/${encodeURIComponent(state.project.id)}/collections/${encodeURIComponent(state.collection)}/records/${encodeURIComponent(id)}`, { method: "DELETE" });
    toast("Record deleted");
    await renderRecords($("#view"));
  } catch (err) { toast(err.message, true); }
}

async function renderKeys(view) {
  const result = await api(`/api/projects/${encodeURIComponent(state.project.id)}/keys`);
  const keys = result.keys || [];
  const active = keys.filter((key) => !key.revoked_at);
  const list = keys.map((key) => `
    <div class="key-row"><div class="key-main"><div class="key-title">${escapeHtml(key.label)} <span class="scope">${escapeHtml(key.scopes)}</span></div><div class="key-prefix">${escapeHtml(key.key_prefix)}••••••••••••••</div><div class="key-meta">Created ${escapeHtml(new Date(key.created_at).toLocaleDateString())} · ${key.revoked_at ? "Revoked" : "Active"}${key.allowed_origins && key.allowed_origins !== "[]" ? ` · Origin restricted` : ""}</div></div>${key.revoked_at ? `<span class="small-muted">Revoked</span>` : `<button class="button small danger" data-revoke-key="${escapeHtml(key.id)}">Revoke</button>`}</div>`).join("");
  view.innerHTML = `${pageHeader("SECURITY", "API keys", `${active.length} active key${active.length === 1 ? "" : "s"} · Keys allow other apps to access this project's data.`, `<button class="button primary" id="add-key">＋ Create API key</button>`)}
    ${state.oneTimeKey ? `<div class="notice"><strong>Copy your new API key now</strong><p>This value is shown only once. VoxyDB stores a one-way hash, so it cannot show the full key again.</p><div class="secret-line"><code id="new-key-value">${escapeHtml(state.oneTimeKey)}</code><button class="button small" id="copy-new-key">Copy</button></div></div>` : ""}
    <div class="panel"><div class="panel-head"><div><h3>Project keys</h3><p>Revoke a key immediately if it is lost or exposed.</p></div></div>${list ? `<div class="key-list">${list}</div>` : `<div class="empty-state"><div class="empty-icon">⚿</div><h3>No API keys yet</h3><p>Create a key to connect your website, Android app or another backend.</p><button class="button primary" id="first-key">Create API key</button></div>`}</div>
    <div class="panel"><h3 style="margin:0 0 8px;font-size:13px">Key safety</h3><p class="docs-copy">A read-only key can be placed in a browser or mobile client, but it still exposes data allowed by that key. Keep <code>write</code> and <code>read_write</code> keys on a trusted server. Configure allowed origins for browser use. Rotate any key that leaks.</p></div>`;
  $("#add-key")?.addEventListener("click", () => showDialog("key-dialog"));
  $("#first-key")?.addEventListener("click", () => showDialog("key-dialog"));
  $$('[data-revoke-key]').forEach((button) => button.addEventListener("click", () => revokeKey(button.dataset.revokeKey)));
  $("#copy-new-key")?.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(state.oneTimeKey); toast("API key copied"); }
    catch { toast("Select and copy the key manually", true); }
  });
}

async function revokeKey(id) {
  if (!confirm("Revoke this API key now? Apps using it will stop working.")) return;
  try {
    await api(`/api/keys/${encodeURIComponent(id)}`, { method: "DELETE" });
    toast("API key revoked");
    await renderKeys($("#view"));
  } catch (err) { toast(err.message, true); }
}

function renderDocs(view) {
  const base = location.origin;
  const projectId = state.project.id;
  const endpoint = `${base}/v1/projects/${projectId}/collections/posts/records`;
  const sdkImport = `${base}/voxydb.js`;
  view.innerHTML = `${pageHeader("DEVELOPER GUIDE", "Connect your app", "One project ID and an API key connect websites, Android apps, Flutter apps, Python services and backend APIs.")}
    <div class="panel"><div class="panel-head"><div><h3>1. Your database endpoint</h3><p>Change <code>posts</code> to any collection you created.</p></div></div><div class="docs-code">${escapeHtml(endpoint)}</div><p class="docs-copy">Project ID: <code>${escapeHtml(projectId)}</code> · SDK: <code>${escapeHtml(sdkImport)}</code></p></div>
    <div class="grid-two">
      <div class="panel"><h3 style="margin:0 0 10px;font-size:13px">2. Load data</h3><p class="docs-copy">Use a read-only key in browsers and mobile apps. Keep write-capable keys on a trusted server.</p><div class="docs-code">import { VoxyDB } from "${escapeHtml(sdkImport)}";
const db = new VoxyDB({
  baseUrl: "${escapeHtml(base)}",
  projectId: "${escapeHtml(projectId)}",
  apiKey: "YOUR_READ_ONLY_KEY"
});
const snapshot = await db.list("posts", 50);
render(snapshot.records);</div></div>
      <div class="panel"><h3 style="margin:0 0 10px;font-size:13px">3. Save data</h3><p class="docs-copy">Run writes from your server using a write-capable project key. VoxyDB generates record IDs and supports safe retries.</p><div class="docs-code">const saved = await db.create("posts", {
  title: "Hello VoxyDB",
  published: true
}, {
  idempotencyKey: "create-post-001"
});
console.log(saved.record.id);</div></div>
    </div>
    <div class="panel"><h3 style="margin:0 0 8px;font-size:13px">4. Live updates with recovery</h3><p class="docs-copy">Pass the snapshot cursor to the subscription. VoxyDB replays changes missed while disconnected. If the cursor is older than the seven-day event history, reload a fresh snapshot.</p><div class="docs-code">const stop = await db.subscribe("posts", (change) => {
  console.log(change.type, change.record || change.id);
}, {
  cursor: snapshot.cursor,
  onStatus: console.log,
  onSnapshotRequired: async () => {
    const fresh = await db.list("posts", 50);
    render(fresh.records);
    return fresh.cursor;
  }
});
// Call stop() when the page or component is closed.</div></div>
    <div class="panel"><h3 style="margin:0 0 8px;font-size:13px">5. Other platforms</h3><p class="docs-copy">Any language that can send HTTPS requests can use the REST API. Copy the Android/Kotlin, Flutter/Dart, Python, Node.js and React examples from the <code>examples/</code> folder in the source ZIP. Use the REST changes endpoint for non-JavaScript clients that need event recovery.</p><div class="docs-code">GET    /v1/projects/${escapeHtml(projectId)}/collections/posts/records
POST   /v1/projects/${escapeHtml(projectId)}/collections/posts/records
GET    /v1/projects/${escapeHtml(projectId)}/collections/posts/records/{recordId}
PUT    /v1/projects/${escapeHtml(projectId)}/collections/posts/records/{recordId}
PATCH  /v1/projects/${escapeHtml(projectId)}/collections/posts/records/{recordId}
DELETE /v1/projects/${escapeHtml(projectId)}/collections/posts/records/{recordId}
GET    /v1/projects/${escapeHtml(projectId)}/collections/posts/changes?after=CURSOR</div></div>
    <div class="panel"><h3 style="margin:0 0 8px;font-size:13px">Security and limits</h3><p class="docs-copy">Use read-only API keys in public code; never put write keys in website bundles or mobile APKs. Records are JSON objects up to 32 KB. List pages contain up to 100 records; change-log pages up to 500 events. Events are retained for seven days. D1 is the primary transactional store; Drive is an asynchronous optional mirror.</p></div>`;
}

async function signOut() {
  closeDashboardRealtime();
  try { await api("/api/auth/logout", { method: "POST", body: "{}" }); } catch { /* continue to sign-in */ }
  state.user = null; state.projects = []; state.project = null;
  renderLogin();
}

$("#project-form").addEventListener("submit", async (event) => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  const name = $("#project-name").value.trim();
  const button = $("#create-project-submit"); button.disabled = true;
  try {
    const result = await api("/api/projects", { method: "POST", body: jsonBody({ name }) });
    closeDialog("project-dialog");
    $("#project-form").reset();
    await loadProjects();
    state.project = state.projects.find((item) => item.id === result.project.id) || state.projects[0];
    state.page = "overview";
    renderShell(); toast("Project created");
  } catch (err) { toast(err.message, true); }
  finally { button.disabled = false; }
});

$("#collection-form").addEventListener("submit", async (event) => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  const name = $("#collection-name").value.trim();
  const button = $("#create-collection-submit"); button.disabled = true;
  try {
    await api(`/api/projects/${encodeURIComponent(state.project.id)}/collections`, { method: "POST", body: jsonBody({ name }) });
    closeDialog("collection-dialog"); $("#collection-form").reset();
    toast("Collection created");
    await loadProjects();
    state.collection = null; state.page = "collections";
    renderShell();
  } catch (err) { toast(err.message, true); }
  finally { button.disabled = false; }
});

$("#record-form").addEventListener("submit", async (event) => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  const button = $("#save-record-submit"); button.disabled = true;
  try {
    const data = JSON.parse($("#record-json").value);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Record must be a JSON object");
    const base = `/api/projects/${encodeURIComponent(state.project.id)}/collections/${encodeURIComponent(state.collection)}/records`;
    const path = state.editingRecordId ? `${base}/${encodeURIComponent(state.editingRecordId)}` : base;
    await api(path, { method: state.editingRecordId ? "PUT" : "POST", body: jsonBody({ data }) });
    closeDialog("record-dialog"); toast(state.editingRecordId ? "Record updated" : "Record saved");
    await renderRecords($("#view"));
  } catch (err) { toast(err instanceof SyntaxError ? "Please enter valid JSON" : err.message, true); }
  finally { button.disabled = false; }
});

$("#key-form").addEventListener("submit", async (event) => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  const button = $("#create-key-submit"); button.disabled = true;
  try {
    const body = {
      label: $("#key-label").value.trim(),
      scopes: $("#key-scopes").value,
      allowedOrigins: $("#key-origins").value.trim(),
    };
    const result = await api(`/api/projects/${encodeURIComponent(state.project.id)}/keys`, { method: "POST", body: jsonBody(body) });
    state.oneTimeKey = result.key.value;
    closeDialog("key-dialog");
    await renderKeys($("#view"));
    toast("API key created — copy it now");
  } catch (err) { toast(err.message, true); }
  finally { button.disabled = false; }
});

async function boot() {
  try {
    const result = await api("/api/me");
    if (!result.authenticated) { renderLogin(); return; }
    state.user = result.user;
    await loadProjects();
    if (new URLSearchParams(location.search).get("drive") === "connected") {
      state.page = "storage";
      history.replaceState({}, "", location.pathname);
    }
    renderShell();
    if (state.page === "storage") toast("Google Drive connected successfully");
  } catch (err) {
    renderLogin(err.message);
  }
}

boot();
