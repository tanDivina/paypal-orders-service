import { beforeEach, describe, expect, it } from "vitest";
import { openDb, runMigrations, type Db } from "../src/db.js";
import type { PayPalClient } from "../src/paypal/client.js";
import { handleWebhook } from "../src/paypal/webhooks.js";

const HEADERS = {
  "paypal-transmission-id": "t-1",
  "paypal-transmission-sig": "sig",
  "paypal-transmission-time": "2026-01-01T00:00:00Z",
  "paypal-cert-url": "https://api.sandbox.paypal.com/certs/CERT",
  "paypal-auth-algo": "SHA256withRSA",
};

function stubPaypal(verified: boolean | Error): PayPalClient {
  return {
    verifyWebhookSignature: async () => {
      if (verified instanceof Error) throw verified;
      return verified;
    },
  } as unknown as PayPalClient;
}

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
  runMigrations(db, "migrations");
  db.prepare("INSERT INTO orders (id, reference_id, amount_usd, status) VALUES ('ORD-1', 'r', '10.00', 'CREATED')").run();
});

const ctx = (verified: boolean | Error) => ({ db, paypal: stubPaypal(verified), webhookId: "WH-1" });

describe("handleWebhook edge cases", () => {
  it("rejects a body that is not JSON", async () => {
    expect((await handleWebhook(ctx(true), "{nope", HEADERS)).status).toBe(400);
  });

  it("rejects an event without id or type", async () => {
    const res = await handleWebhook(ctx(true), JSON.stringify({ resource: {} }), HEADERS);
    expect(res).toMatchObject({ status: 400, body: { error: "missing_event_fields" } });
  });

  it("rejects a delivery with missing transmission headers", async () => {
    const res = await handleWebhook(ctx(true), JSON.stringify({ id: "E1", event_type: "X" }), {
      ...HEADERS,
      "paypal-transmission-sig": undefined,
    });
    expect(res).toMatchObject({ status: 400, body: { error: "missing_transmission_headers" } });
  });

  it("marks the order AUTHORIZED on PAYMENT.AUTHORIZATION.CREATED", async () => {
    const event = {
      id: "E2",
      event_type: "PAYMENT.AUTHORIZATION.CREATED",
      resource: { id: "0AUTH1", supplementary_data: { related_ids: { order_id: "ORD-1" } } },
    };
    const res = await handleWebhook(ctx(true), JSON.stringify(event), HEADERS);
    expect(res.status).toBe(200);
    expect(db.prepare("SELECT status, authorization_id FROM orders WHERE id = 'ORD-1'").get()).toMatchObject({
      status: "AUTHORIZED",
      authorization_id: "0AUTH1",
    });
  });

  it("marks the order CAPTURE_DENIED on PAYMENT.CAPTURE.DENIED", async () => {
    const event = {
      id: "E3",
      event_type: "PAYMENT.CAPTURE.DENIED",
      resource: { id: "2CAPX", supplementary_data: { related_ids: { order_id: "ORD-1" } } },
    };
    await handleWebhook(ctx(true), JSON.stringify(event), HEADERS);
    expect(db.prepare("SELECT status FROM orders WHERE id = 'ORD-1'").get()).toMatchObject({ status: "CAPTURE_DENIED" });
  });

  it("records unknown event types without touching orders", async () => {
    const event = { id: "E4", event_type: "BILLING.SUBSCRIPTION.CREATED", resource: { id: "S-1" } };
    const res = await handleWebhook(ctx(true), JSON.stringify(event), HEADERS);
    expect(res.status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) AS n FROM webhook_events WHERE id = 'E4'").get()).toMatchObject({ n: 1 });
    expect(db.prepare("SELECT status FROM orders WHERE id = 'ORD-1'").get()).toMatchObject({ status: "CREATED" });
  });

  it("does not downgrade an already captured order on a late AUTHORIZATION.CREATED", async () => {
    db.prepare("UPDATE orders SET status = 'CAPTURED' WHERE id = 'ORD-1'").run();
    const event = {
      id: "E5",
      event_type: "PAYMENT.AUTHORIZATION.CREATED",
      resource: { id: "0AUTH2", supplementary_data: { related_ids: { order_id: "ORD-1" } } },
    };
    await handleWebhook(ctx(true), JSON.stringify(event), HEADERS);
    expect(db.prepare("SELECT status FROM orders WHERE id = 'ORD-1'").get()).toMatchObject({ status: "CAPTURED" });
  });
});
