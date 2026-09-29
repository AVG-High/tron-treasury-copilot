import "dotenv/config";
import { createApp } from "./app.js";

const host = process.env.HOST?.trim() || "127.0.0.1";
const port = Number(process.env.PORT || 4187);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT must be an integer between 1 and 65535.");
if (
  !["127.0.0.1", "localhost", "::1"].includes(host) &&
  !process.env.PUBLIC_ORIGIN
) {
  throw new Error("Non-loopback HOST requires an explicit PUBLIC_ORIGIN.");
}

const server = createApp().listen(port, host, () => {
  // Startup metadata only. Request bodies, wallet addresses and balances are never logged.
  console.info(`TRON Treasury Copilot API listening on ${host}:${port}`);
});
server.requestTimeout = 30_000;
server.headersTimeout = 10_000;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
