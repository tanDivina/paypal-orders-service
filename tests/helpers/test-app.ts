// Boots the real HTTP server against a fresh in-memory database and the fake
// PayPal API, and hands back a fetch-style client plus direct DB access.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../../src/app.js";
import { signToken } from "../../src/auth.js";
import { openDb, runMigrations, type Db } from "../../src/db.js";
import { PayPalClient } from "../../src/paypal/client.js";
import { startFakePayPal, type FakePayPal } from "./fake-paypal.js";

const JWT_SECRET = "integration-test-secret";

export interface TestApp {
  baseUrl: string;
  db: Db;
  paypal: FakePayPal;
  token: string;
  request(path: string, init?: RequestInit & { auth?: boolean }): Promise<{ status: number; body: any }>;
  close(): Promise<void>;
}

export async function startTestApp(): Promise<TestApp> {
  const paypal = await startFakePayPal();
  const db = openDb(":memory:");
  runMigrations(db, "migrations");

  const app = createApp({
    db,
    paypal: new PayPalClient({ baseUrl: paypal.baseUrl, clientId: "fake-client", clientSecret: "fake-secret" }),
    paypalBaseUrl: paypal.baseUrl,
    webhookId: paypal.webhookId,
    jwtSecret: JWT_SECRET,
  });
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  const token = signToken("integration-tests", JWT_SECRET);

  return {
    baseUrl,
    db,
    paypal,
    token,
    async request(path, init = {}) {
      const { auth = true, headers, ...rest } = init;
      const res = await fetch(`${baseUrl}${path}`, {
        ...rest,
        headers: {
          "Content-Type": "application/json",
          ...(auth ? { Authorization: `Bearer ${token}` } : {}),
          ...(headers as Record<string, string> | undefined),
        },
      });
      return { status: res.status, body: await res.json() };
    },
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
      await paypal.close();
    },
  };
}
