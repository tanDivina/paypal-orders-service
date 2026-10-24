import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestApp, type TestApp } from "../helpers/test-app.js";

let app: TestApp;
beforeAll(async () => {
  app = await startTestApp();
});
afterAll(() => app.close());

describe("Orders v2 authorize & capture integration", () => {
  it("rejects order creation without a valid bearer token", async () => {
    const res = await app.request("/orders", { method: "POST", auth: false, body: JSON.stringify({ amountUsd: "1000.00" }) });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  it("creates a PayPal order with intent AUTHORIZE and persists it", async () => {
    const res = await app.request("/orders", {
      method: "POST",
      body: JSON.stringify({ amountUsd: "1000.00", referenceId: "milestone-2", idempotencyKey: "key-create-1" }),
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("CREATED");
    const row = app.db.prepare("SELECT * FROM orders WHERE id = ?").get(res.body.orderId) as any;
    expect(row.amount_usd).toBe("1000.00");
    expect(app.paypal.orders.get(res.body.orderId)?.referenceId).toBe("milestone-2");
  });

  it("returns the same order when the request is retried with the same idempotency key", async () => {
    const payload = { amountUsd: "250.00", referenceId: "retry-me", idempotencyKey: "key-retry-1" };
    const first = await app.request("/orders", { method: "POST", body: JSON.stringify(payload) });
    const second = await app.request("/orders", { method: "POST", body: JSON.stringify(payload) });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ orderId: first.body.orderId, idempotent: true });
    const count = app.db.prepare("SELECT COUNT(*) AS n FROM orders WHERE idempotency_key = ?").get("key-retry-1") as any;
    expect(count.n).toBe(1);
  });

  it("authorizes an approved order and stores the authorization id", async () => {
    const created = await app.request("/orders", {
      method: "POST",
      body: JSON.stringify({ amountUsd: "1000.00", referenceId: "to-authorize", idempotencyKey: "key-auth-1" }),
    });
    const res = await app.request(`/orders/${created.body.orderId}/authorize`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.body.authorizationId).toMatch(/^0AUTH/);
    const row = app.db.prepare("SELECT status, authorization_id FROM orders WHERE id = ?").get(created.body.orderId) as any;
    expect(row).toMatchObject({ status: "AUTHORIZED", authorization_id: res.body.authorizationId });
  });

  it("surfaces INSTRUMENT_DECLINED as 422 and keeps the order unauthorized", async () => {
    const created = await app.request("/orders", {
      method: "POST",
      body: JSON.stringify({ amountUsd: "99.00", referenceId: "DECLINE-card", idempotencyKey: "key-decline-1" }),
    });
    const res = await app.request(`/orders/${created.body.orderId}/authorize`, { method: "POST" });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("INSTRUMENT_DECLINED");
    const row = app.db.prepare("SELECT status, authorization_id FROM orders WHERE id = ?").get(created.body.orderId) as any;
    expect(row.status).toBe("CREATED");
    expect(row.authorization_id).toBeNull();
  });

  it("captures an authorization and marks the order captured", async () => {
    const created = await app.request("/orders", {
      method: "POST",
      body: JSON.stringify({ amountUsd: "1000.00", referenceId: "to-capture", idempotencyKey: "key-capture-1" }),
    });
    const auth = await app.request(`/orders/${created.body.orderId}/authorize`, { method: "POST" });
    const res = await app.request(`/authorizations/${auth.body.authorizationId}/capture`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.body.captureId).toMatch(/^2CAP/);
    const row = app.db.prepare("SELECT status, capture_id FROM orders WHERE id = ?").get(created.body.orderId) as any;
    expect(row).toMatchObject({ status: "CAPTURED", capture_id: res.body.captureId });
  });
});
