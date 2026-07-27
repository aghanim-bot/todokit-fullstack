import { createApp } from "./app.js";
import { openDatabase } from "./database.js";

function portFromEnvironment(): number {
  const port = Number(process.env.PORT ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return port;
}

const db = openDatabase();
const app = await createApp(db, { logger: true });
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "Shutting down");
  try {
    await app.close();
    db.close();
    process.exitCode = 0;
  } catch (error) {
    app.log.error(error, "Shutdown failed");
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: "0.0.0.0", port: portFromEnvironment() });
} catch (error) {
  app.log.error(error);
  db.close();
  process.exitCode = 1;
}
