// PayPal REST client: OAuth2 client-credentials token with caching, Orders v2
// (intent=AUTHORIZE) and authorization capture. Every mutating call carries a
// PayPal-Request-Id so retries are idempotent on PayPal's side.

export interface PayPalConfig {
  baseUrl: string; // https://api-m.sandbox.paypal.com or a test stand-in
  clientId: string;
  clientSecret: string;
}

export class PayPalApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly issues: string[],
    public readonly debugId?: string
  ) {
    super(`PayPal ${status} ${code}${issues.length ? `: ${issues.join(", ")}` : ""}`);
  }
}

interface CachedToken {
  value: string;
  expiresAtMs: number;
}

export class PayPalClient {
  #cfg: PayPalConfig;
  #token: CachedToken | null = null;

  constructor(cfg: PayPalConfig) {
    this.#cfg = cfg;
  }

  async #accessToken(): Promise<string> {
    if (this.#token && this.#token.expiresAtMs > Date.now() + 60_000) return this.#token.value;
    const basic = Buffer.from(`${this.#cfg.clientId}:${this.#cfg.clientSecret}`).toString("base64");
    const res = await fetch(`${this.#cfg.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new PayPalApiError(res.status, "OAUTH_FAILED", []);
    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.#token = { value: data.access_token, expiresAtMs: Date.now() + data.expires_in * 1000 };
    return data.access_token;
  }

  async #request<T>(method: "POST" | "GET", path: string, opts: { body?: unknown; requestId?: string } = {}): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.#accessToken()}`,
      "Content-Type": "application/json",
    };
    if (opts.requestId) headers["PayPal-Request-Id"] = opts.requestId;
    const res = await fetch(`${this.#cfg.baseUrl}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) {
      throw new PayPalApiError(
        res.status,
        data.name ?? "PAYPAL_ERROR",
        Array.isArray(data.details) ? data.details.map((d: { issue?: string }) => d.issue ?? "unknown") : [],
        data.debug_id
      );
    }
    return data as T;
  }

  /** Creates an Orders v2 order with intent AUTHORIZE: funds are held, not charged. */
  async createOrder(opts: { referenceId: string; amountUsd: string; requestId: string }) {
    return this.#request<{ id: string; status: string }>("POST", "/v2/checkout/orders", {
      requestId: opts.requestId,
      body: {
        intent: "AUTHORIZE",
        purchase_units: [{ reference_id: opts.referenceId, amount: { currency_code: "USD", value: opts.amountUsd } }],
      },
    });
  }

  /** Places the hold after buyer approval; returns the authorization id to capture later. */
  async authorizeOrder(orderId: string, requestId: string) {
    const data = await this.#request<{
      status: string;
      purchase_units?: { payments?: { authorizations?: { id: string; status: string }[] } }[];
    }>("POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`, { requestId, body: {} });
    const auth = data.purchase_units?.[0]?.payments?.authorizations?.[0];
    if (!auth) throw new PayPalApiError(502, "NO_AUTHORIZATION_RETURNED", []);
    return { status: data.status, authorizationId: auth.id, authorizationStatus: auth.status };
  }

  /** Captures a previously placed authorization (the actual charge). */
  async captureAuthorization(authorizationId: string, requestId: string) {
    return this.#request<{ id: string; status: string }>(
      "POST",
      `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/capture`,
      { requestId, body: {} }
    );
  }

  /**
   * Asks PayPal whether a webhook delivery is genuine. Returns true only on
   * verification_status === "SUCCESS"; any transport error bubbles up so the
   * caller can refuse the event.
   */
  async verifyWebhookSignature(opts: {
    webhookId: string;
    headers: Record<string, string | undefined>;
    event: unknown;
  }): Promise<boolean> {
    const h = opts.headers;
    const data = await this.#request<{ verification_status: string }>("POST", "/v1/notifications/verify-webhook-signature", {
      body: {
        auth_algo: h["paypal-auth-algo"],
        cert_url: h["paypal-cert-url"],
        transmission_id: h["paypal-transmission-id"],
        transmission_sig: h["paypal-transmission-sig"],
        transmission_time: h["paypal-transmission-time"],
        webhook_id: opts.webhookId,
        webhook_event: opts.event,
      },
    });
    return data.verification_status === "SUCCESS";
  }
}
