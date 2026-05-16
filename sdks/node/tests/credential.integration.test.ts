import { describe, expect, test } from "vitest";
import {
  ApiKeyCredential,
  BoxliteRestOptions,
  type Credential,
} from "../lib/index.js";

describe("ApiKeyCredential", () => {
  test("getToken returns the key with no expiry", () => {
    const cred = new ApiKeyCredential("blk_live_secret");
    const tok = cred.getToken();
    expect(tok.token).toBe("blk_live_secret");
    // API keys never expire — the core fetches once and caches.
    expect(tok.expiresAt ?? null).toBeNull();
  });

  test("fromEnv unset returns null", () => {
    delete process.env.BOXLITE_API_KEY;
    expect(ApiKeyCredential.fromEnv()).toBeNull();
  });

  test("fromEnv set returns a credential", () => {
    process.env.BOXLITE_API_KEY = "env-key";
    const cred = ApiKeyCredential.fromEnv();
    expect(cred).not.toBeNull();
    expect(cred!.getToken().token).toBe("env-key");
    delete process.env.BOXLITE_API_KEY;
  });

  test("structurally satisfies the Credential interface", () => {
    // The whole point of the abstraction: a function typed against
    // `Credential` accepts ApiKeyCredential with no nominal `implements`.
    const useCredential = (c: Credential): string => c.getToken().token;
    expect(useCredential(new ApiKeyCredential("k"))).toBe("k");
  });
});

describe("BoxliteRestOptions", () => {
  test("carries url, credential, and prefix", () => {
    const cred = new ApiKeyCredential("blk_live_x");
    const opts = new BoxliteRestOptions({
      url: "https://api.example.com",
      credential: cred,
      prefix: "v2",
    });
    expect(opts.url).toBe("https://api.example.com");
    expect(opts.credential).toBe(cred);
    expect(opts.prefix).toBe("v2");
  });

  test("credential and prefix are optional (unauthenticated)", () => {
    const opts = new BoxliteRestOptions({ url: "http://localhost:8100" });
    expect(opts.url).toBe("http://localhost:8100");
    expect(opts.credential).toBeUndefined();
    expect(opts.prefix).toBeUndefined();
  });
});
