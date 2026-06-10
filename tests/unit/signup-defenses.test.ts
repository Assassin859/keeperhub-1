import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RateLimitRule = { window: number; max: number };
type RateLimitRuleFn = (
  req: Request,
  defaults: RateLimitRule
) => Promise<RateLimitRule | false> | RateLimitRule | false;
type CaptchaPluginCtx = {
  logger: {
    info: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
};
type CaptchaPluginShape = {
  id: string;
  options: { provider?: string; endpoints?: string[]; secretKey?: string };
};
type CaptchaPluginWithRequest = CaptchaPluginShape & {
  onRequest: (request: Request, ctx: CaptchaPluginCtx) => Promise<unknown>;
};

const TEST_API_KEY = "kha_test_signup_defenses_key";
const MISSING_CAPTCHA_SECRET_ERROR = /TURNSTILE_SECRET_KEY is required/;

function clearTurnstileEnv(): void {
  // biome-ignore lint/performance/noDelete: env vars must be removed, not stringified
  delete process.env.TURNSTILE_SECRET_KEY;
  // biome-ignore lint/performance/noDelete: same
  delete process.env.TEST_API_KEY;
  // biome-ignore lint/performance/noDelete: same
  delete process.env.INCLUDE_TEST_ENDPOINTS;
  // biome-ignore lint/performance/noDelete: same
  delete process.env.ALLOW_TEST_ENDPOINTS;
  // biome-ignore lint/performance/noDelete: same
  delete process.env.NEXT_PHASE;
  // biome-ignore lint/performance/noDelete: same
  delete process.env.TURNSTILE_ENFORCE;
  // biome-ignore lint/performance/noDelete: same
  delete process.env.LOAD_TEST_CAPTCHA_BYPASS_TOKEN;
}

describe("signup defenses: captcha plugin", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    clearTurnstileEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    clearTurnstileEnv();
  });

  it("does not load the captcha plugin in test mode even when secret is set", async () => {
    vi.stubEnv("NODE_ENV", "test");
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    const { auth } = await import("@/lib/auth");
    const plugin = (auth.options.plugins ?? []).find(
      (p) => (p as CaptchaPluginShape).id === "captcha"
    );
    expect(plugin).toBeUndefined();
  });

  it("does not load the captcha plugin when TURNSTILE_SECRET_KEY is missing outside production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CI", "");
    const { auth } = await import("@/lib/auth");
    const plugin = (auth.options.plugins ?? []).find(
      (p) => (p as CaptchaPluginShape).id === "captcha"
    );
    expect(plugin).toBeUndefined();
  });

  it("loads the captcha plugin gated to /sign-up/email when secret is set outside test mode", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CI", "");
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    const { auth } = await import("@/lib/auth");
    const plugin = (auth.options.plugins ?? []).find(
      (p) => (p as CaptchaPluginShape).id === "captcha"
    ) as CaptchaPluginShape | undefined;
    expect(plugin).toBeDefined();
    expect(plugin?.options.provider).toBe("cloudflare-turnstile");
    expect(plugin?.options.endpoints).toEqual(["/sign-up/email"]);
    expect(plugin?.options.secretKey).toBe("test-secret");
  });

  it("throws at module load in production when TURNSTILE_SECRET_KEY is missing", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(import("@/lib/auth")).rejects.toThrow(
      MISSING_CAPTCHA_SECRET_ERROR
    );
  });

  it("does not throw during next build phase even without the secret", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    const mod = await import("@/lib/auth");
    expect(mod.auth).toBeDefined();
    const plugin = (mod.auth.options.plugins ?? []).find(
      (p) => (p as CaptchaPluginShape).id === "captcha"
    );
    expect(plugin).toBeUndefined();
  });

  it("skips captcha plugin when admin test endpoints are enabled outside production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CI", "");
    vi.stubEnv("INCLUDE_TEST_ENDPOINTS", "true");
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    process.env.TEST_API_KEY = "kha_admin_test";
    const { auth } = await import("@/lib/auth");
    const plugin = (auth.options.plugins ?? []).find(
      (p) => (p as CaptchaPluginShape).id === "captcha"
    );
    expect(plugin).toBeUndefined();
  });

  it("loads the captcha plugin when TURNSTILE_ENFORCE=true even with admin test endpoints enabled", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CI", "");
    vi.stubEnv("INCLUDE_TEST_ENDPOINTS", "true");
    vi.stubEnv("TURNSTILE_ENFORCE", "true");
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    process.env.TEST_API_KEY = "kha_admin_test";
    const { auth } = await import("@/lib/auth");
    const plugin = (auth.options.plugins ?? []).find(
      (p) => (p as CaptchaPluginShape).id === "captcha"
    ) as CaptchaPluginShape | undefined;
    expect(plugin).toBeDefined();
    expect(plugin?.options.endpoints).toEqual(["/sign-up/email"]);
  });

  it("throws at module load when TURNSTILE_ENFORCE=true but the secret is missing", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CI", "");
    vi.stubEnv("TURNSTILE_ENFORCE", "true");
    await expect(import("@/lib/auth")).rejects.toThrow(
      MISSING_CAPTCHA_SECRET_ERROR
    );
  });
});

describe("signup defenses: load-test captcha bypass", () => {
  const BYPASS_TOKEN = "0123456789abcdef0123456789abcdef";
  const SAME_LENGTH_WRONG = "ffffffffffffffffffffffffffffffff";
  const SIGNUP_URL = "http://localhost:3000/api/auth/sign-up/email";

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    clearTurnstileEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    clearTurnstileEnv();
  });

  async function loadCaptchaPlugin(): Promise<CaptchaPluginWithRequest> {
    const { auth } = await import("@/lib/auth");
    const plugin = (auth.options.plugins ?? []).find(
      (p) => (p as { id?: string }).id === "captcha"
    );
    if (!plugin) {
      throw new Error("captcha plugin not loaded");
    }
    return plugin as unknown as CaptchaPluginWithRequest;
  }

  function makeRequest(headers: Record<string, string> = {}): Request {
    return new Request(SIGNUP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ email: "x@x.test", password: "x", name: "x" }),
    });
  }

  function makeCtx(): CaptchaPluginCtx & {
    logger: {
      info: ReturnType<typeof vi.fn>;
      error: ReturnType<typeof vi.fn>;
    };
  } {
    return {
      logger: {
        info: vi.fn() as unknown as (...args: unknown[]) => void,
        error: vi.fn() as unknown as (...args: unknown[]) => void,
      },
    } as never;
  }

  it("passes through when the bypass header matches the env token", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CI", "");
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    process.env.LOAD_TEST_CAPTCHA_BYPASS_TOKEN = BYPASS_TOKEN;
    const plugin = await loadCaptchaPlugin();
    const ctx = makeCtx();
    const result = await plugin.onRequest(
      makeRequest({ "X-Load-Test-Captcha-Bypass": BYPASS_TOKEN }),
      ctx
    );
    expect(result).toBeUndefined();
    expect(ctx.logger.info).toHaveBeenCalledWith(
      "captcha bypass header accepted",
      expect.objectContaining({ endpoint: expect.stringContaining(SIGNUP_URL) })
    );
  });

  it("delegates to the underlying captcha check when no bypass header is sent", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CI", "");
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    process.env.LOAD_TEST_CAPTCHA_BYPASS_TOKEN = BYPASS_TOKEN;
    const plugin = await loadCaptchaPlugin();
    const ctx = makeCtx();
    const result = await plugin.onRequest(makeRequest(), ctx);
    expect(result).toBeDefined();
    expect(ctx.logger.info).not.toHaveBeenCalledWith(
      "captcha bypass header accepted",
      expect.anything()
    );
  });

  it("delegates when the bypass header is the same length but the wrong value", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CI", "");
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    process.env.LOAD_TEST_CAPTCHA_BYPASS_TOKEN = BYPASS_TOKEN;
    const plugin = await loadCaptchaPlugin();
    expect(SAME_LENGTH_WRONG.length).toBe(BYPASS_TOKEN.length);
    const ctx = makeCtx();
    const result = await plugin.onRequest(
      makeRequest({ "X-Load-Test-Captcha-Bypass": SAME_LENGTH_WRONG }),
      ctx
    );
    expect(result).toBeDefined();
    expect(ctx.logger.info).not.toHaveBeenCalledWith(
      "captcha bypass header accepted",
      expect.anything()
    );
  });

  it("delegates when the bypass header is the wrong length", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CI", "");
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    process.env.LOAD_TEST_CAPTCHA_BYPASS_TOKEN = BYPASS_TOKEN;
    const plugin = await loadCaptchaPlugin();
    const ctx = makeCtx();
    const result = await plugin.onRequest(
      makeRequest({ "X-Load-Test-Captcha-Bypass": "too-short" }),
      ctx
    );
    expect(result).toBeDefined();
    expect(ctx.logger.info).not.toHaveBeenCalledWith(
      "captcha bypass header accepted",
      expect.anything()
    );
  });

  it("ignores the bypass header entirely when the env token is unset", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CI", "");
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    // LOAD_TEST_CAPTCHA_BYPASS_TOKEN intentionally left unset (production posture)
    const plugin = await loadCaptchaPlugin();
    const ctx = makeCtx();
    const result = await plugin.onRequest(
      makeRequest({ "X-Load-Test-Captcha-Bypass": BYPASS_TOKEN }),
      ctx
    );
    expect(result).toBeDefined();
    expect(ctx.logger.info).not.toHaveBeenCalledWith(
      "captcha bypass header accepted",
      expect.anything()
    );
  });
});

describe("signup defenses: /sign-up/email rate limit rule", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    clearTurnstileEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    clearTurnstileEnv();
  });

  it("declares /sign-up/email before /* so first-match wins on signup", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { auth } = await import("@/lib/auth");
    const keys = Object.keys(auth.options.rateLimit?.customRules ?? {});
    const signupIdx = keys.indexOf("/sign-up/email");
    const wildcardIdx = keys.indexOf("/*");
    expect(signupIdx).toBeGreaterThanOrEqual(0);
    expect(wildcardIdx).toBeGreaterThanOrEqual(0);
    expect(signupIdx).toBeLessThan(wildcardIdx);
  });

  it("returns { window: 3600, max: 5 } for unauthenticated signup attempts", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { auth } = await import("@/lib/auth");
    const rule = auth.options.rateLimit?.customRules?.["/sign-up/email"] as
      | RateLimitRuleFn
      | undefined;
    expect(typeof rule).toBe("function");
    const req = new Request("http://localhost:3000/api/auth/sign-up/email");
    const resolved = await rule?.(req, { window: 60, max: 100 });
    expect(resolved).toEqual({ window: 3600, max: 5 });
  });

  it("returns false (bypass) when a valid X-Test-API-Key is presented", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("INCLUDE_TEST_ENDPOINTS", "true");
    process.env.TEST_API_KEY = TEST_API_KEY;
    const { auth } = await import("@/lib/auth");
    const rule = auth.options.rateLimit?.customRules?.["/sign-up/email"] as
      | RateLimitRuleFn
      | undefined;
    const req = new Request("http://localhost:3000/api/auth/sign-up/email", {
      headers: { "X-Test-API-Key": TEST_API_KEY },
    });
    const resolved = await rule?.(req, { window: 60, max: 100 });
    expect(resolved).toBe(false);
  });
});
