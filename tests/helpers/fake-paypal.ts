// A local stand-in for the PayPal REST API, faithful to the endpoints this
// service uses: OAuth2 token, Orders v2 create/authorize, authorization
// capture and verify-webhook-signature. It runs as a real HTTP server so the
// client under test exercises genuine requests, headers and error bodies.
import { createHmac, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

interface FakeOrder {
  id: string;
  referenceId: string;
  amountUsd: string;
  status: "CREATED" | "COMPLETED";
  authorizationId?: string;
}

export interface FakePayPal {
  baseUrl: string;
  webhookId: string;
  /** Orders created through the fake, keyed by PayPal-Request-Id. */
  ordersByRequestId: Map<string, FakeOrder>;
  orders: Map<string, FakeOrder>;
  /** When true, verify-webhook-signature responds 503. */
  verificationDown: boolean;
  tokenRequests: number;
  signEvent(event: unknown): Record<string, string>;
  close(): Promise<void>;
}

const WEBHOOK_SIGNING_SECRET = "fake-paypal-webhook-cert";

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function signature(transmissionId: string, transmissionTime: string, event: unknown): string {
  return createHmac("sha256", WEBHOOK_SIGNING_SECRET)
    .update(`${transmissionId}|${transmissionTime}|${JSON.stringify(event)}`)
    .digest("base64");
}

export async function startFakePayPal(): Promise<FakePayPal> {
  const ordersByRequestId = new Map<string, FakeOrder>();
  const orders = new Map<string, FakeOrder>();
  const state = { verificationDown: false, tokenRequests: 0 };

  const server: Server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = req.url ?? "/";

    if (req.method === "HEAD" && url === "/v1/oauth2/token") {
      res.writeHead(405).end();
      return;
    }
    if (req.method === "POST" && url === "/v1/oauth2/token") {
      state.tokenRequests += 1;
      const basic = req.headers.authorization?.startsWith("Basic ")
        ? Buffer.from(req.headers.authorization.slice(6), "base64").toString()
        : "";
      const [clientId, clientSecret] = basic.split(":");
      if (!clientId || !clientSecret) {
        send(401, { error: "invalid_client" });
        return;
      }
      send(200, { access_token: `fake-token-${state.tokenRequests}`, token_type: "Bearer", expires_in: 3600 });
      return;
    }

    // Everything else requires the bearer token issued above.
    if (!req.headers.authorization?.startsWith("Bearer fake-token-")) {
      send(401, { name: "UNAUTHORIZED", details: [] });
      return;
    }

    if (req.method === "POST" && url === "/v2/checkout/orders") {
      const requestId = String(req.headers["paypal-request-id"] ?? "");
      const body = JSON.parse(await readBody(req)) as {
        intent?: string;
        purchase_units?: { reference_id?: string; amount?: { value?: string } }[];
      };
      if (body.intent !== "AUTHORIZE") {
        send(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "INVALID_INTENT" }] });
        return;
      }
      if (requestId && ordersByRequestId.has(requestId)) {
        const existing = ordersByRequestId.get(requestId)!;
        send(200, { id: existing.id, status: existing.status });
        return;
      }
      const unit = body.purchase_units?.[0];
      const order: FakeOrder = {
        id: `5O${randomUUID().replaceAll("-", "").slice(0, 15).toUpperCase()}`,
        referenceId: unit?.reference_id ?? "",
        amountUsd: unit?.amount?.value ?? "0.00",
        status: "CREATED",
      };
      orders.set(order.id, order);
      if (requestId) ordersByRequestId.set(requestId, order);
      send(201, { id: order.id, status: order.status });
      return;
    }

    const authorizeMatch = req.method === "POST" && url.match(/^\/v2\/checkout\/orders\/([^/]+)\/authorize$/);
    if (authorizeMatch) {
      const order = orders.get(decodeURIComponent(authorizeMatch[1]!));
      if (!order) {
        send(404, { name: "RESOURCE_NOT_FOUND", details: [{ issue: "INVALID_RESOURCE_ID" }] });
        return;
      }
      if (order.referenceId.startsWith("DECLINE")) {
        send(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "INSTRUMENT_DECLINED" }], debug_id: randomUUID() });
        return;
      }
      order.status = "COMPLETED";
      order.authorizationId = `0AUTH${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
      send(201, {
        id: order.id,
        status: "COMPLETED",
        purchase_units: [{ payments: { authorizations: [{ id: order.authorizationId, status: "CREATED" }] } }],
      });
      return;
    }

    const captureMatch = req.method === "POST" && url.match(/^\/v2\/payments\/authorizations\/([^/]+)\/capture$/);
    if (captureMatch) {
      const authId = decodeURIComponent(captureMatch[1]!);
      const order = [...orders.values()].find((o) => o.authorizationId === authId);
      if (!order) {
        send(404, { name: "RESOURCE_NOT_FOUND", details: [{ issue: "INVALID_RESOURCE_ID" }] });
        return;
      }
      send(201, { id: `2CAP${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`, status: "COMPLETED" });
      return;
    }

    if (req.method === "POST" && url === "/v1/notifications/verify-webhook-signature") {
      if (state.verificationDown) {
        send(503, { name: "SERVICE_UNAVAILABLE", details: [] });
        return;
      }
      const body = JSON.parse(await readBody(req)) as {
        transmission_id?: string;
        transmission_time?: string;
        transmission_sig?: string;
        webhook_event?: unknown;
      };
      const expected = signature(body.transmission_id ?? "", body.transmission_time ?? "", body.webhook_event);
      send(200, { verification_status: body.transmission_sig === expected ? "SUCCESS" : "FAILURE" });
      return;
    }

    send(404, { name: "RESOURCE_NOT_FOUND", details: [] });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    webhookId: "WH-FAKE-0001",
    ordersByRequestId,
    orders,
    get verificationDown() {
      return state.verificationDown;
    },
    set verificationDown(v: boolean) {
      state.verificationDown = v;
    },
    get tokenRequests() {
      return state.tokenRequests;
    },
    signEvent(event: unknown): Record<string, string> {
      const transmissionId = randomUUID();
      const transmissionTime = new Date().toISOString();
      return {
        "paypal-transmission-id": transmissionId,
        "paypal-transmission-time": transmissionTime,
        "paypal-transmission-sig": signature(transmissionId, transmissionTime, event),
        "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-FAKE",
        "paypal-auth-algo": "SHA256withRSA",
      };
    },
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
