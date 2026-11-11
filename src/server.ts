import { createServer } from "node:http";
import { createApp } from "./app.js";
import { openDb, runMigrations } from "./db.js";
import { PayPalClient } from "./paypal/client.js";

const paypalBaseUrl = process.env.PAYPAL_API_BASE ?? "https://api-m.sandbox.paypal.com";
const db = openDb();
runMigrations(db, "migrations");

const app = createApp({
  db,
  paypal: new PayPalClient({
    baseUrl: paypalBaseUrl,
    clientId: process.env.PAYPAL_CLIENT_ID ?? "",
    clientSecret: process.env.PAYPAL_CLIENT_SECRET ?? "",
  }),
  paypalBaseUrl,
  webhookId: process.env.PAYPAL_WEBHOOK_ID ?? "",
  jwtSecret: process.env.AUTH_JWT_SECRET ?? "dev-only-secret",
});

const port = Number(process.env.PORT ?? 8787);
createServer(app).listen(port, () => console.log(`paypal-orders-service on :${port}`));
