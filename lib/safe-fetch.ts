import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { lookup as dnsLookup } from "node:dns";
import { BlockList, isIP } from "node:net";
import { captureException } from "@sentry/nextjs";
import { Agent, buildConnector, fetch as undiciFetch } from "undici";
import { getMetricsCollector } from "@/lib/metrics";

export type SsrfBlockReason =
  | "scheme"
  | "private-ip"
  | "loopback"
  | "link-local"
  | "multicast"
  | "reserved"
  | "ipv4-mapped-private";

export class SsrfBlockedError extends Error {
  readonly code = "SSRF_BLOCKED";
  readonly hostname: string;
  readonly resolvedIp?: string;
  readonly reason: SsrfBlockReason;

  constructor(params: {
    hostname: string;
    resolvedIp?: string;
    reason: SsrfBlockReason;
    message: string;
  }) {
    super(params.message);
    this.name = "SsrfBlockedError";
    this.hostname = params.hostname;
    this.resolvedIp = params.resolvedIp;
    this.reason = params.reason;
  }
}

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

const IPV4_MAPPED_PREFIX = "::ffff:";

const IPV4_MULTICAST_REGEX = /^(22[4-9]|23\d)\./;

const IPV4_MAPPED_HEX_REGEX = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;

/**
 * Denylist of IP ranges that must never be reached from user-controlled fetch.
 * IPv4 covers unspecified, private, loopback, link-local (incl. IMDS
 * 169.254.169.254), CGNAT, documentation ranges, benchmarking, multicast,
 * reserved, broadcast. IPv6 covers unspecified, loopback, IPv4-mapped, NAT64,
 * discard, ULA, link-local, multicast.
 */
function buildBlockList(): BlockList {
  const list = new BlockList();

  list.addSubnet("0.0.0.0", 8, "ipv4");
  list.addSubnet("10.0.0.0", 8, "ipv4");
  list.addSubnet("100.64.0.0", 10, "ipv4");
  list.addSubnet("127.0.0.0", 8, "ipv4");
  list.addSubnet("169.254.0.0", 16, "ipv4");
  list.addSubnet("172.16.0.0", 12, "ipv4");
  list.addSubnet("192.0.0.0", 24, "ipv4");
  list.addSubnet("192.0.2.0", 24, "ipv4");
  list.addSubnet("192.88.99.0", 24, "ipv4");
  list.addSubnet("192.168.0.0", 16, "ipv4");
  list.addSubnet("198.18.0.0", 15, "ipv4");
  list.addSubnet("198.51.100.0", 24, "ipv4");
  list.addSubnet("203.0.113.0", 24, "ipv4");
  list.addSubnet("224.0.0.0", 4, "ipv4");
  list.addSubnet("240.0.0.0", 4, "ipv4");
  list.addAddress("255.255.255.255", "ipv4");

  list.addAddress("::", "ipv6");
  list.addAddress("::1", "ipv6");
  // Note: ::ffff:0:0/96 (IPv4-mapped IPv6) is intentionally not added here.
  // Node's BlockList treats that subnet as "all IPv4", which makes every
  // IPv4 check return true. IPv4-mapped IPv6 addresses pointing at private
  // IPv4 space are caught via extractMappedIpv4 below.
  list.addSubnet("64:ff9b::", 96, "ipv6");
  list.addSubnet("100::", 64, "ipv6");
  list.addSubnet("fc00::", 7, "ipv6");
  list.addSubnet("fe80::", 10, "ipv6");
  list.addSubnet("ff00::", 8, "ipv6");

  return list;
}

const BLOCK_LIST = buildBlockList();

function reasonForIpv4(ip: string): SsrfBlockReason {
  if (ip.startsWith("127.")) {
    return "loopback";
  }
  if (ip.startsWith("169.254.")) {
    return "link-local";
  }
  if (IPV4_MULTICAST_REGEX.test(ip)) {
    return "multicast";
  }
  if (ip.startsWith("240.") || ip === "255.255.255.255") {
    return "reserved";
  }
  return "private-ip";
}

function reasonForIpv6(ip: string): SsrfBlockReason {
  const normalised = ip.toLowerCase();
  if (normalised === "::1") {
    return "loopback";
  }
  if (normalised.startsWith(IPV4_MAPPED_PREFIX)) {
    return "ipv4-mapped-private";
  }
  if (normalised.startsWith("fe80:")) {
    return "link-local";
  }
  if (normalised.startsWith("ff")) {
    return "multicast";
  }
  return "private-ip";
}

/**
 * Extract the embedded IPv4 from an IPv4-mapped IPv6 address. Handles both
 * dotted-quad (`::ffff:169.254.169.254`) and hex (`::ffff:a9fe:a9fe`) forms.
 */
function extractMappedIpv4(ipv6: string): string | undefined {
  const lower = ipv6.toLowerCase();
  if (!lower.startsWith(IPV4_MAPPED_PREFIX)) {
    return;
  }
  const suffix = lower.slice(IPV4_MAPPED_PREFIX.length);
  if (isIP(suffix) === 4) {
    return suffix;
  }
  const hexMatch = suffix.match(IPV4_MAPPED_HEX_REGEX);
  if (!hexMatch) {
    return;
  }
  const high = Number.parseInt(hexMatch[1] ?? "", 16);
  const low = Number.parseInt(hexMatch[2] ?? "", 16);
  if (!(Number.isFinite(high) && Number.isFinite(low))) {
    return;
  }
  return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff].join(
    "."
  );
}

/**
 * Check an IP literal against the denylist. For IPv4-mapped IPv6 addresses,
 * the embedded IPv4 is also matched against the IPv4 denylist so an IPv6
 * literal cannot be used to bypass an IPv4-range check.
 */
export function isBlockedIp(
  ip: string
): { blocked: true; reason: SsrfBlockReason } | { blocked: false } {
  const family = isIP(ip);
  if (family === 0) {
    return { blocked: false };
  }

  const familyKey = family === 4 ? "ipv4" : "ipv6";
  if (BLOCK_LIST.check(ip, familyKey)) {
    return {
      blocked: true,
      reason: family === 4 ? reasonForIpv4(ip) : reasonForIpv6(ip),
    };
  }

  if (family === 6) {
    const mapped = extractMappedIpv4(ip);
    if (mapped && BLOCK_LIST.check(mapped, "ipv4")) {
      return { blocked: true, reason: "ipv4-mapped-private" };
    }
  }

  return { blocked: false };
}

export function isShadowMode(): boolean {
  return process.env.SAFE_FETCH_ENFORCE !== "true";
}

type BlockContext = {
  hostname: string;
  resolvedIp?: string;
  reason: SsrfBlockReason;
  plugin?: string;
};

/**
 * Carries the calling plugin label across the async boundary into the
 * module-level Agent's lookup callback, where the original `safeFetch`
 * closure is out of scope. Without this, DNS-path blocks record
 * plugin_name="unknown" — precisely the case the shadow-mode soak needs
 * to attribute.
 */
const pluginContext = new AsyncLocalStorage<{ plugin?: string }>();

function currentPlugin(): string | undefined {
  return pluginContext.getStore()?.plugin;
}

function recordBlock(ctx: BlockContext, shadow: boolean): void {
  const metrics = getMetricsCollector();
  metrics.incrementCounter("safe_fetch.blocks.total", {
    reason: ctx.reason,
    plugin_name: ctx.plugin ?? "unknown",
    shadow: shadow ? "true" : "false",
  });

  // Do NOT route through logUserError: it forwards caller labels to a
  // Prometheus error metric with a fixed initial labelset, which rejects
  // hostname/resolved_ip with "Added label not included in initial labelset"
  // and turns shadow mode into a synchronous throw.
  const modeSuffix = shadow ? " (shadow mode)" : "";
  const resolvedSuffix =
    ctx.resolvedIp !== undefined && ctx.resolvedIp !== ctx.hostname
      ? ` -> ${ctx.resolvedIp}`
      : "";
  const pluginSuffix =
    ctx.plugin === undefined ? "" : ` [plugin=${ctx.plugin}]`;
  console.warn(
    `[safe-fetch] Blocked outbound request${modeSuffix}: ${ctx.hostname}${resolvedSuffix} (reason=${ctx.reason})${pluginSuffix}`
  );

  captureException(new Error(`safe-fetch block: ${ctx.reason}`), {
    level: "warning",
    tags: {
      safe_fetch_reason: ctx.reason,
      safe_fetch_shadow: shadow ? "true" : "false",
      plugin_name: ctx.plugin ?? "unknown",
    },
    extra: {
      hostname: ctx.hostname,
      resolved_ip: ctx.resolvedIp,
    },
  });
}

function blockedMessage(ctx: BlockContext): string {
  const ipPart = ctx.resolvedIp ? ` (resolved to ${ctx.resolvedIp})` : "";
  return `Outbound request to ${ctx.hostname}${ipPart} blocked by SSRF policy (${ctx.reason}).`;
}

function stripIpv6Brackets(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

function extractUrlString(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

/**
 * Custom undici connector that resolves DNS, validates the resolved IP, and
 * only then hands off to the default TCP/TLS connector. Invoked per TCP
 * connection including redirect hops, so validation fires every time.
 *
 * The base connector is given the already-resolved IP as `hostname`, so it
 * does not perform a second DNS lookup — this closes the TOCTOU window
 * between our check and the socket handshake.
 */
type ConnectOptions = Parameters<ReturnType<typeof buildConnector>>[0];
type ConnectCallback = Parameters<ReturnType<typeof buildConnector>>[1];

const baseConnector = buildConnector({});

function validatingConnect(
  options: ConnectOptions,
  callback: ConnectCallback
): void {
  const { hostname } = options;

  // IP literals are caught at the URL-entry check in `safeFetch` already,
  // so `hostname` here is expected to be a domain name. Still, resolve it
  // and re-check defensively — covers any code path that might feed an IP
  // through the connector directly.
  dnsLookup(hostname, { family: 0 }, (err, address) => {
    if (err) {
      callback(err as Error, null);
      return;
    }
    const resolved = String(address);
    const check = isBlockedIp(resolved);
    const shadow = isShadowMode();
    const plugin = currentPlugin();

    if (check.blocked) {
      recordBlock(
        { hostname, resolvedIp: resolved, reason: check.reason, plugin },
        shadow
      );
      if (!shadow) {
        callback(
          new SsrfBlockedError({
            hostname,
            resolvedIp: resolved,
            reason: check.reason,
            message: blockedMessage({
              hostname,
              resolvedIp: resolved,
              reason: check.reason,
              plugin,
            }),
          }),
          null
        );
        return;
      }
    }

    // Hand off to the default connector with the already-resolved address.
    baseConnector({ ...options, hostname: resolved }, callback);
  });
}

/**
 * Module-level Agent. Pooling outbound sockets across requests is fine because
 * the connector fires per connection, not per Agent.
 */
const safeAgent = new Agent({ connect: validatingConnect });

export type SafeFetchOptions = RequestInit & {
  /** Plugin identifier for observability (e.g. "code", "webhook"). */
  plugin?: string;
};

/**
 * Drop-in replacement for `fetch` that refuses to connect to private,
 * loopback, link-local, or reserved addresses. Non-http(s) schemes are
 * rejected at the entry. IP-literal URLs are validated before any network
 * call; DNS-resolved IPs are validated via a custom undici Agent lookup on
 * every redirect hop.
 *
 * Shadow mode is the default: blocks are logged and counted but the request
 * proceeds. Set `SAFE_FETCH_ENFORCE=true` to enforce.
 */
export async function safeFetch(
  input: RequestInfo | URL,
  init?: SafeFetchOptions
): Promise<Response> {
  const plugin = init?.plugin;
  const shadow = isShadowMode();

  const rawUrl = extractUrlString(input);

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (_err) {
    throw new TypeError(`safe-fetch: invalid URL "${rawUrl}"`);
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    recordBlock(
      { hostname: parsed.hostname, reason: "scheme", plugin },
      shadow
    );
    if (!shadow) {
      throw new SsrfBlockedError({
        hostname: parsed.hostname,
        reason: "scheme",
        message: `safe-fetch: scheme "${parsed.protocol}" not allowed`,
      });
    }
  }

  const hostname = stripIpv6Brackets(parsed.hostname);
  if (isIP(hostname) !== 0) {
    const check = isBlockedIp(hostname);
    if (check.blocked) {
      recordBlock(
        { hostname, resolvedIp: hostname, reason: check.reason, plugin },
        shadow
      );
      if (!shadow) {
        throw new SsrfBlockedError({
          hostname,
          resolvedIp: hostname,
          reason: check.reason,
          message: blockedMessage({
            hostname,
            resolvedIp: hostname,
            reason: check.reason,
            plugin,
          }),
        });
      }
    }
  }

  const { plugin: _omit, ...fetchInit } = init ?? {};

  // undici's fetch accepts a `dispatcher` option at runtime that is not part
  // of the DOM `RequestInit` type, and undici's own `RequestInit` differs
  // from the DOM's on `body` nullability. Build the call args via the
  // parameter type of the function we're calling to avoid `any`.
  type UndiciFetchInit = Parameters<typeof undiciFetch>[1];
  const initWithDispatcher = {
    ...fetchInit,
    dispatcher: safeAgent,
  } as unknown as UndiciFetchInit;

  // Run the fetch inside the plugin-context store so the shared Agent's
  // DNS lookup can attribute blocks to the calling plugin.
  const response = await pluginContext.run({ plugin }, () =>
    undiciFetch(rawUrl, initWithDispatcher)
  );
  return response as unknown as Response;
}
