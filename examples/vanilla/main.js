import { VoxyDB } from "../../public/voxydb.js";

const db = new VoxyDB({
  baseUrl: "https://YOUR-VOXYDB-WORKER.workers.dev",
  projectId: "YOUR_PROJECT_ID",
  apiKey: "YOUR_READ_ONLY_KEY",
});

const snapshot = await db.list("posts", 50);
console.log("Initial posts", snapshot.records);

const stop = await db.subscribe("posts", (event) => {
  console.log("Database changed", event);
}, {
  cursor: snapshot.cursor,
  onStatus: (status) => console.log("Connection", status),
  onSnapshotRequired: async () => {
    const fresh = await db.list("posts", 50);
    console.log("Reloaded snapshot", fresh.records);
    return fresh.cursor;
  },
});

window.addEventListener("pagehide", stop, { once: true });
