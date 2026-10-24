import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { healthReport } from "../src/health.js";

describe("health degradation", () => {
  it("reports degraded when the PayPal gateway is unreachable", async () => {
    const db = openDb(":memory:");
    const report = await healthReport(db, "http://127.0.0.1:1"); // nothing listens here
    expect(report.paypalGateway.ok).toBe(false);
    expect(report.status).toBe("degraded");
  });

  it("reports degraded when the database connection is closed", async () => {
    const db = openDb(":memory:");
    db.close();
    const report = await healthReport(db, "http://127.0.0.1:1");
    expect(report.db.ok).toBe(false);
    expect(report.status).toBe("degraded");
  });
});
