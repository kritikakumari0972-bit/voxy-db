import { VoxyDB } from "../../public/voxydb.js";

const db = new VoxyDB({
  baseUrl: process.env.VOXYDB_URL,
  projectId: process.env.VOXYDB_PROJECT_ID,
  apiKey: process.env.VOXYDB_WRITE_KEY,
});

const result = await db.create("orders", {
  orderNumber: "ORD-1001",
  status: "created",
  total: 1499,
}, { idempotencyKey: "order-ORD-1001-create" });

console.log("Stored order:", result.record);
