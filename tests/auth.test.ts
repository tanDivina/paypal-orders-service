import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authenticate, signToken, verifyToken } from "../src/auth.js";

const SECRET = "test-secret";

const forge = (header: object, payloadRaw: string) => {
  const h = Buffer.from(JSON.stringify(header)).toString("base64url");
  const p = Buffer.from(payloadRaw).toString("base64url");
  const s = createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${s}`;
};

describe("auth middleware primitives", () => {
  it("accepts a freshly signed token", () => {
    const claims = verifyToken(signToken("client-1", SECRET), SECRET);
    expect(claims?.sub).toBe("client-1");
  });

  it("rejects a token signed with a different secret", () => {
    expect(verifyToken(signToken("client-1", "other-secret"), SECRET)).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const [h, , s] = signToken("client-1", SECRET).split(".") as [string, string, string];
    const forged = Buffer.from(JSON.stringify({ sub: "admin", iat: 0, exp: 9999999999 })).toString("base64url");
    expect(verifyToken(`${h}.${forged}.${s}`, SECRET)).toBeNull();
  });

  it("rejects an expired token", () => {
    expect(verifyToken(signToken("client-1", SECRET, -10), SECRET)).toBeNull();
  });

  it("rejects a signed token whose payload is not JSON", () => {
    expect(verifyToken(forge({ alg: "HS256", typ: "JWT" }, "not-json"), SECRET)).toBeNull();
  });

  it("rejects a signed token with wrong claim types", () => {
    expect(verifyToken(forge({ alg: "HS256", typ: "JWT" }, JSON.stringify({ sub: 42, exp: "later" })), SECRET)).toBeNull();
  });

  it("rejects tokens that declare a different algorithm", () => {
    expect(verifyToken(forge({ alg: "none", typ: "JWT" }, JSON.stringify({ sub: "x", exp: 9999999999 })), SECRET)).toBeNull();
  });

  it("rejects malformed and non-bearer Authorization headers", () => {
    expect(authenticate(undefined, SECRET)).toBeNull();
    expect(authenticate("Basic abc", SECRET)).toBeNull();
    expect(authenticate("Bearer not.a.jwt", SECRET)).toBeNull();
  });
});
