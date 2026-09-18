import { openDb } from "./db.mjs";
import { seed, shouldSeedDemo } from "./seed.mjs";
import { makeApp } from "./app.mjs";
import { expireOrders } from "./commerce.mjs";
const db = openDb(process.env.DATABASE_PATH);
if (shouldSeedDemo()) seed(db);
expireOrders(db);
const expiryTimer = setInterval(() => {
  try {
    expireOrders(db);
  } catch (error) {
    console.error("Order expiration failed", error);
  }
}, 60000);
expiryTimer.unref();
const port = Number(process.env.PORT ?? 3001);
const server = makeApp(db).listen(port, "127.0.0.1", () =>
  console.log(`Athlentry API running at http://127.0.0.1:${port}`),
);
function close() {
  clearInterval(expiryTimer);
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on("SIGINT", close);
process.on("SIGTERM", close);
