// Staging health endpoint (Vercel function): real database round-trip plus
// PayPal gateway reachability, same report the self-hosted server serves.
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
