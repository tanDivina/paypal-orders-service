// Staging health endpoint (Vercel function). The serverless staging
// deployment has no persistent database, so it does not pretend to check
// one: the report has db: null and its status depends on a live
// reachability check of the PayPal gateway. The self-hosted server
// (src/server.ts) serves the full report, including the database check
// against the migrated orders and webhook_events tables.
import { healthReport } from "../src/health.js";

const paypalBaseUrl = process.env.PAYPAL_API_BASE ?? "https://api-m.sandbox.paypal.com";
// Warm the gateway cache at module load so the first probed request is fast.
const warmup = healthReport(null, paypalBaseUrl).catch(() => null);

export default async function handler(req: unknown, res: any) {
  await warmup;
  const report = await healthReport(null, paypalBaseUrl);
  res.status(report.status === "ok" ? 200 : 503).json(report);
}
