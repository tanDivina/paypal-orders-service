import crypto from "crypto";
import type { Db } from "../db.js";
import type { PayPalClient } from "./client.js";

// Webhook reconciliation engine. Every delivery is verified with PayPal's
// verify-webhook-signature API before anything is trusted; unverified or
// unverifiable deliveries are rejected with HTTP 400. Event ids are recorded
// so a replayed delivery reconciles nothing twice.

const REQUIRED_HEADERS = [
  "paypal-transmission-id",
  "paypal-transmission-sig",
  "paypal-transmission-time",
  "paypal-cert-url",
  "paypal-auth-algo",
] as const;

export interface WebhookEvent {
  id: string;
  event_type: string;
  resource?: { id?: string; supplementary_data?: { related_ids?: { order_id?: string } } };
}

export interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
}

function orderIdFrom(event: WebhookEvent): string | null {
  return event.resource?.supplementary_data?.related_ids?.order_id ?? null;
}

function applyEvent(db: Db, event: WebhookEvent): void {
  const resourceId = event.resource?.id ?? null;
  const orderId = orderIdFrom(event);
  switch (event.event_type) {
    case "PAYMENT.AUTHORIZATION.CREATED":
      if (orderId)
        db.prepare(
          "UPDATE orders SET status = 'AUTHORIZED', authorization_id = ?, updated_at = datetime('now') WHERE id = ? AND status = 'CREATED'"
        ).run(resourceId, orderId);
      break;
    case "PAYMENT.CAPTURE.COMPLETED":
      if (orderId)
        db.prepare(
          "UPDATE orders SET status = 'CAPTURED', capture_id = ?, updated_at = datetime('now') WHERE id = ?"
        ).run(resourceId, orderId);
      break;
    case "PAYMENT.CAPTURE.DENIED":
      if (orderId)
        db.prepare("UPDATE orders SET status = 'CAPTURE_DENIED', updated_at = datetime('now') WHERE id = ?").run(orderId);
      break;
    default:
      // Unknown event types are recorded (for the audit trail) but change nothing.
      break;
  }
}

export async function handleWebhook(
  ctx: { db: Db; paypal: PayPalClient; webhookId: string },
  rawBody: string,
  headers: Record<string, string | undefined>
): Promise<WebhookResult> {
  let event: WebhookEvent;
  try {
    event = JSON.parse(rawBody) as WebhookEvent;
  } catch {
    return { status: 400, body: { error: "invalid_json" } };
  }
  if (!event?.id || !event.event_type) {
    return { status: 400, body: { error: "missing_event_fields" } };
  }
  if (REQUIRED_HEADERS.some((h) => !headers[h])) {
    return { status: 400, body: { error: "missing_transmission_headers" } };
  }

  let verified: boolean;
  try {
    verified = await ctx.paypal.verifyWebhookSignature({ webhookId: ctx.webhookId, headers, event });
  } catch {
    // If PayPal can't confirm the signature, the event is not trusted.
    return { status: 400, body: { error: "verification_unavailable" } };
  }
  if (!verified) {
    return { status: 400, body: { error: "invalid_signature" } };
  }

  const inserted = ctx.db
    .prepare("INSERT OR IGNORE INTO webhook_events (id, event_type, resource_id) VALUES (?, ?, ?)")
    .run(event.id, event.event_type, event.resource?.id ?? null);
  if (inserted.changes === 0) {
    return { status: 200, body: { received: true, duplicate: true } };
  }

  applyEvent(ctx.db, event);
  return { status: 200, body: { received: true } };
}
