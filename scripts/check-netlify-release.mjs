import { getDatabaseUrl, getMigrationDatabaseUrl } from "@agent-native/core/db";

if (process.env.AUTH_DISABLED !== "false" || process.env.VITEST) {
  throw new Error("Production requires AUTH_DISABLED=false and VITEST unset.");
}
if ((process.env.BETTER_AUTH_SECRET?.trim().length ?? 0) < 32) {
  throw new Error("Configure a stable BETTER_AUTH_SECRET of at least 32 characters.");
}
for (const value of [getDatabaseUrl(), getMigrationDatabaseUrl()]) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Configure a dedicated PostgreSQL database."); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) ||
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Runtime and migrations must both target hosted PostgreSQL.");
  }
}
