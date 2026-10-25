import type { Db } from "./db.js";

// Health report for the staging probe: a real database round-trip plus a
// reachability check of the PayPal gateway. The gateway result is cached for
// a minute so health stays fast on warm instances.

export interface HealthReport {
  status: "ok" | "degraded";
  db: { ok: boolean; latencyMs: number };
  paypalGateway: { ok: boolean; latencyMs: number | null; cached: boolean };
  uptimeSeconds: number;
}

const startedAt = Date.now();
const gatewayCache = new Map<string, { ok: boolean; latencyMs: number; at: number }>();
const GATEWAY_CACHE_MS = 60_000;

async function checkGateway(baseUrl: string): Promise<{ ok: boolean; latencyMs: number | null; cached: boolean }> {
  const cached = gatewayCache.get(baseUrl);
  if (cached && Date.now() - cached.at < GATEWAY_CACHE_MS) {
    return { ok: cached.ok, latencyMs: cached.latencyMs, cached: true };
  }
  const started = Date.now();
  let ok: boolean;
  try {
    // Any HTTP response (even 4xx without credentials) proves the gateway is reachable.
    const res = await fetch(`${baseUrl}/v1/oauth2/token`, {
      method: "GET",
      headers: { "User-Agent": "PayPal-HealthCheck/1.0", "Accept": "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    ok = res.status < 500;
  } catch {
    ok = false;
  }
  const result = { ok, latencyMs: Date.now() - started, at: Date.now() };
  gatewayCache.set(baseUrl, result);
  return { ok: result.ok, latencyMs: result.latencyMs, cached: false };
}

export async function healthReport(db: Db, paypalBaseUrl: string): Promise<HealthReport> {
  const dbStart = Date.now();
  let dbOk = false;
  try {
    db.prepare("SELECT 1 AS one").get();
    dbOk = true;
  } catch {
    dbOk = false;
  }
  const dbLatency = Date.now() - dbStart;
  const gateway = await checkGateway(paypalBaseUrl);
  return {
    status: dbOk && gateway.ok ? "ok" : "degraded",
    db: { ok: dbOk, latencyMs: dbLatency },
    paypalGateway: gateway,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
  };
}
