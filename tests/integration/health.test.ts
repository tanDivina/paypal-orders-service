import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestApp, type TestApp } from "../helpers/test-app.js";

let app: TestApp;
beforeAll(async () => {
  app = await startTestApp();
});
afterAll(() => app.close());

describe("health endpoint", () => {
  it("reports a healthy database and PayPal gateway with 200", async () => {
    const res = await app.request("/api/health", { auth: false });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.db.ok).toBe(true);
    expect(res.body.paypalGateway.ok).toBe(true);
  });

  it("responds in under 250ms once warm", async () => {
    await app.request("/api/health", { auth: false }); // warm the gateway cache
    const started = Date.now();
    const res = await app.request("/api/health", { auth: false });
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(250);
  });
});
