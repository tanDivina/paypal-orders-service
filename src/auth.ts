import { createHmac, timingSafeEqual } from "node:crypto";

// Minimal HS256 JWT issue/verify, dependency-free. Tokens carry a subject
// (the API client id) and an expiry; verification rejects malformed tokens,
// forged signatures and expired claims.

export interface TokenClaims {
  sub: string;
  iat: number;
  exp: number;
}

const b64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

function hs256(secret: string, data: string): Buffer {
  return createHmac("sha256", secret).update(data).digest();
}

export function signToken(sub: string, secret: string, ttlSeconds = 900): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ sub, iat: now, exp: now + ttlSeconds } satisfies TokenClaims));
  const signature = hs256(secret, `${header}.${payload}`).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

export function verifyToken(token: string, secret: string): TokenClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];

  let alg: unknown;
  try {
    alg = (JSON.parse(Buffer.from(header, "base64url").toString()) as { alg?: unknown }).alg;
  } catch {
    return null;
  }
  if (alg !== "HS256") return null; // no algorithm downgrade

  const expected = hs256(secret, `${header}.${payload}`);
  let given: Buffer;
  try {
    given = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

  let claims: TokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as TokenClaims;
  } catch {
    return null;
  }
  if (typeof claims.sub !== "string" || typeof claims.exp !== "number") return null;
  if (claims.exp * 1000 <= Date.now()) return null;
  return claims;
}

/** Reads `Authorization: Bearer <jwt>`; returns the claims or null. */
export function authenticate(authorizationHeader: string | undefined, secret: string): TokenClaims | null {
  if (!authorizationHeader?.startsWith("Bearer ")) return null;
  return verifyToken(authorizationHeader.slice("Bearer ".length).trim(), secret);
}
