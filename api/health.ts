// Staging health endpoint (Vercel function). Vercel functions have no
// persistent disk, so each instance opens a fresh in-memory SQLite database
// and applies the real migrations. The health check then does a round-trip
// through the same db layer production uses (not persisted data) plus a
// PayPal gateway reachability check. The self-hosted server (src/server.ts)
// serves the same report against its on-disk database.
import { openDb, runMigrations } from "../src/db.js";
import { healthReport } from "../src/health.js";

const paypalBaseUrl = process.env.PAYPAL_API_BASE ?? "https://api-m.sandbox.paypal.com";
const db = openDb(":memory:");
runMigrations(db, "migrations");
// Warm the gateway cache at module load so the first probed request is fast.
const warmup = healthReport(db, paypalBaseUrl).catch(() => null);

export default async function handler(req: unknown, res: any) {
  await warmup;
  const report = await healthReport(db, paypalBaseUrl);
  res.status(report.status === "ok" ? 200 : 503).json(report);
}
