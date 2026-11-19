import { useEffect, useState } from "react";
import { VoxyDB } from "../../public/voxydb.js";

const db = new VoxyDB({
  baseUrl: import.meta.env.VITE_VOXYDB_URL,
  projectId: import.meta.env.VITE_VOXYDB_PROJECT_ID,
  apiKey: import.meta.env.VITE_VOXYDB_READ_KEY,
});

export function usePosts() {
  const [posts, setPosts] = useState([]);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState(null);

  useEffect(() => {
    let stop = () => {};
    let active = true;
    let cursor = 0;

    async function start() {
      try {
        const snapshot = await db.list("posts", 100);
        if (!active) return;
        setPosts(snapshot.records);
        cursor = snapshot.cursor;
        stop = await db.subscribe("posts", (event) => {
          if (!active) return;
          setPosts((current) => {
            if (event.type === "record.deleted") return current.filter((item) => item.id !== event.id);
            const index = current.findIndex((item) => item.id === event.record?.id);
            if (index < 0) return [event.record, ...current];
            const next = [...current];
            next[index] = event.record;
            return next;
          });
        }, {
          cursor,
          onStatus: setStatus,
          onSnapshotRequired: async () => {
            const fresh = await db.list("posts", 100);
            if (active) setPosts(fresh.records);
            return fresh.cursor;
          },
        });
      } catch (cause) {
        if (active) setError(cause);
      }
    }

    start();
    return () => { active = false; stop(); };
  }, []);

  return { posts, status, error };
}
