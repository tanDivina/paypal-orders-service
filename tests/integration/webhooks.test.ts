import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestApp, type TestApp } from "../helpers/test-app.js";

let app: TestApp;
beforeAll(async () => {
  app = await startTestApp();
});
afterAll(() => app.close());
beforeEach(() => {
  app.paypal.verificationDown = false;
});

async function seedAuthorizedOrder(key: string): Promise<string> {
  const created = await app.request("/orders", {
    method: "POST",
    body: JSON.stringify({ amountUsd: "1000.00", referenceId: `wh-${key}`, idempotencyKey: key }),
  });
  await app.request(`/orders/${created.body.orderId}/authorize`, { method: "POST" });
  return created.body.orderId;
}

function captureEvent(id: string, orderId: string) {
  return {
    id,
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    resource: { id: `2CAPWH${id}`, supplementary_data: { related_ids: { order_id: orderId } } },
  };
}

async function postWebhook(event: unknown, headers: Record<string, string>) {
  return app.request("/webhooks/paypal", { method: "POST", auth: false, body: JSON.stringify(event), headers });
}

describe("webhook reconciliation engine", () => {
  it("accepts a correctly signed event and reconciles the order to CAPTURED", async () => {
    const orderId = await seedAuthorizedOrder("wh-ok");
    const event = captureEvent("WH-EVT-1", orderId);
    const res = await postWebhook(event, app.paypal.signEvent(event));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
    const row = app.db.prepare("SELECT status, capture_id FROM orders WHERE id = ?").get(orderId) as any;
    expect(row).toMatchObject({ status: "CAPTURED", capture_id: "2CAPWHWH-EVT-1" });
  });

  it("rejects a tampered event with HTTP 400 and records nothing", async () => {
    const orderId = await seedAuthorizedOrder("wh-forged");
    const event = captureEvent("WH-EVT-2", orderId);
    const headers = app.paypal.signEvent({ ...event, resource: { ...event.resource, id: "something-else" } });
    const res = await postWebhook(event, headers); // body no longer matches the signature
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_signature");
    expect(app.db.prepare("SELECT status FROM orders WHERE id = ?").get(orderId)).toMatchObject({ status: "AUTHORIZED" });
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM webhook_events WHERE id = 'WH-EVT-2'").get()).toMatchObject({ n: 0 });
  });

  it("rejects the event when verify-webhook-signature is unreachable", async () => {
    const orderId = await seedAuthorizedOrder("wh-down");
    const event = captureEvent("WH-EVT-3", orderId);
    const headers = app.paypal.signEvent(event);
    app.paypal.verificationDown = true;
    const res = await postWebhook(event, headers);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("verification_unavailable");
    expect(app.db.prepare("SELECT status FROM orders WHERE id = ?").get(orderId)).toMatchObject({ status: "AUTHORIZED" });
  });

  it("treats a replayed event id as a duplicate and reconciles only once", async () => {
    const orderId = await seedAuthorizedOrder("wh-replay");
    const event = captureEvent("WH-EVT-4", orderId);
    const first = await postWebhook(event, app.paypal.signEvent(event));
    expect(first.status).toBe(200);
    const replay = await postWebhook(event, app.paypal.signEvent(event));
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ received: true, duplicate: true });
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM webhook_events WHERE id = 'WH-EVT-4'").get()).toMatchObject({ n: 1 });
  });
});
