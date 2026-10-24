import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PayPalApiError, PayPalClient } from "../src/paypal/client.js";
import { startTestApp, type TestApp } from "./helpers/test-app.js";

let app: TestApp;
beforeAll(async () => {
  app = await startTestApp();
});
afterAll(() => app.close());

describe("request validation and error mapping", () => {
  it("rejects a malformed USD amount", async () => {
    const res = await app.request("/orders", { method: "POST", body: JSON.stringify({ amountUsd: "12.3.4" }) });
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown route and for unknown resources", async () => {
    expect((await app.request("/nope", { method: "POST", body: "{}" })).status).toBe(404);
    expect((await app.request("/orders/UNKNOWN/authorize", { method: "POST" })).status).toBe(404);
    expect((await app.request("/authorizations/UNKNOWN/capture", { method: "POST" })).status).toBe(404);
  });
});

describe("PayPal client error handling", () => {
  it("fails with OAUTH_FAILED when credentials are rejected", async () => {
    const bad = new PayPalClient({ baseUrl: app.paypal.baseUrl, clientId: "", clientSecret: "" });
    // The fake rejects a missing Basic auth header outright, so the first call throws.
    await expect(bad.createOrder({ referenceId: "x", amountUsd: "1.00", requestId: "r1" })).rejects.toThrowError(
      PayPalApiError
    );
  });

  it("reuses the cached OAuth token across calls", async () => {
    const client = new PayPalClient({ baseUrl: app.paypal.baseUrl, clientId: "id", clientSecret: "secret" });
    const before = app.paypal.tokenRequests;
    await client.createOrder({ referenceId: "a", amountUsd: "1.00", requestId: "tok-1" });
    await client.createOrder({ referenceId: "b", amountUsd: "2.00", requestId: "tok-2" });
    expect(app.paypal.tokenRequests).toBe(before + 1);
  });

  it("propagates PayPal error names and issue details", async () => {
    const client = new PayPalClient({ baseUrl: app.paypal.baseUrl, clientId: "id", clientSecret: "secret" });
    const order = await client.createOrder({ referenceId: "DECLINE-unit", amountUsd: "5.00", requestId: "tok-3" });
    const err = await client.authorizeOrder(order.id, "tok-4").catch((e) => e as PayPalApiError);
    expect(err).toBeInstanceOf(PayPalApiError);
    expect((err as PayPalApiError).status).toBe(422);
    expect((err as PayPalApiError).issues).toContain("INSTRUMENT_DECLINED");
  });
});
