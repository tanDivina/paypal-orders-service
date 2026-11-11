import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { authenticate } from "./auth.js";
import type { Db } from "./db.js";
import { healthReport } from "./health.js";
import { PayPalApiError, type PayPalClient } from "./paypal/client.js";
import { handleWebhook } from "./paypal/webhooks.js";

export interface AppContext {
  db: Db;
  paypal: PayPalClient;
  paypalBaseUrl: string;
  webhookId: string;
  jwtSecret: string;
}

const MAX_BODY_BYTES = 1024 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

function paypalErrorResponse(res: ServerResponse, e: unknown): void {
  if (e instanceof PayPalApiError) {
    json(res, e.status === 422 ? 422 : 502, { error: e.issues[0] ?? e.code, debugId: e.debugId });
  } else {
    json(res, 502, { error: "paypal_unavailable" });
  }
}

/** Builds the request handler used by both the HTTP server and tests. */
export function createApp(ctx: AppContext) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://service.local");
    const method = req.method ?? "GET";

    try {
      if (method === "GET" && url.pathname === "/api/health") {
        const report = await healthReport(ctx.db, ctx.paypalBaseUrl);
        json(res, report.status === "ok" ? 200 : 503, report);
        return;
      }

      if (method === "POST" && url.pathname === "/webhooks/paypal") {
        const raw = await readBody(req);
        const headers: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
        const result = await handleWebhook({ db: ctx.db, paypal: ctx.paypal, webhookId: ctx.webhookId }, raw, headers);
        json(res, result.status, result.body);
        return;
      }

      // Everything below requires a valid bearer token.
      const claims = authenticate(req.headers.authorization, ctx.jwtSecret);
      if (!claims) {
        res.setHeader("WWW-Authenticate", "Bearer");
        json(res, 401, { error: "unauthorized" });
        return;
      }

      if (method === "POST" && url.pathname === "/orders") {
        const body = JSON.parse((await readBody(req)) || "{}") as { amountUsd?: string; referenceId?: string; idempotencyKey?: string };
        if (!body.amountUsd || !/^\d+(\.\d{2})?$/.test(body.amountUsd)) {
          json(res, 400, { error: "amountUsd must be a USD amount like 1000.00" });
          return;
        }
        const idempotencyKey = body.idempotencyKey ?? randomUUID();
        const existing = ctx.db.prepare("SELECT * FROM orders WHERE idempotency_key = ?").get(idempotencyKey) as
          | { id: string; status: string }
          | undefined;
        if (existing) {
          json(res, 200, { orderId: existing.id, status: existing.status, idempotent: true });
          return;
        }
        const referenceId = body.referenceId ?? `ref-${randomUUID()}`;
        try {
          const order = await ctx.paypal.createOrder({ referenceId, amountUsd: body.amountUsd, requestId: idempotencyKey });
          ctx.db
            .prepare("INSERT INTO orders (id, reference_id, amount_usd, status, idempotency_key) VALUES (?, ?, ?, ?, ?)")
            .run(order.id, referenceId, body.amountUsd, order.status, idempotencyKey);
          json(res, 201, { orderId: order.id, status: order.status, idempotent: false });
        } catch (e) {
          paypalErrorResponse(res, e);
        }
        return;
      }

      const authorizeMatch = method === "POST" && url.pathname.match(/^\/orders\/([^/]+)\/authorize$/);
      if (authorizeMatch) {
        const orderId = decodeURIComponent(authorizeMatch[1]!);
        const row = ctx.db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId) as { id: string } | undefined;
        if (!row) {
          json(res, 404, { error: "order_not_found" });
          return;
        }
        try {
          const auth = await ctx.paypal.authorizeOrder(orderId, `auth-${orderId}`);
          ctx.db
            .prepare("UPDATE orders SET status = 'AUTHORIZED', authorization_id = ?, updated_at = datetime('now') WHERE id = ?")
            .run(auth.authorizationId, orderId);
          json(res, 200, { orderId, authorizationId: auth.authorizationId, status: "AUTHORIZED" });
        } catch (e) {
          paypalErrorResponse(res, e);
        }
        return;
      }

      const captureMatch = method === "POST" && url.pathname.match(/^\/authorizations\/([^/]+)\/capture$/);
      if (captureMatch) {
        const authorizationId = decodeURIComponent(captureMatch[1]!);
        const row = ctx.db.prepare("SELECT * FROM orders WHERE authorization_id = ?").get(authorizationId) as
          | { id: string }
          | undefined;
        if (!row) {
          json(res, 404, { error: "authorization_not_found" });
          return;
        }
        try {
          const capture = await ctx.paypal.captureAuthorization(authorizationId, `cap-${authorizationId}`);
          ctx.db
            .prepare("UPDATE orders SET status = 'CAPTURED', capture_id = ?, updated_at = datetime('now') WHERE id = ?")
            .run(capture.id, row.id);
          json(res, 200, { orderId: row.id, captureId: capture.id, status: "CAPTURED" });
        } catch (e) {
          paypalErrorResponse(res, e);
        }
        return;
      }

      json(res, 404, { error: "not_found" });
    } catch (e) {
      json(res, e instanceof Error && e.message === "body too large" ? 413 : 500, {
        error: e instanceof Error ? e.message : "internal_error",
      });
    }
  };
}
