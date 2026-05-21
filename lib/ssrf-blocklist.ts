/**
 * Single source of truth for the SSRF blocklist: CIDR ranges that must
 * never be reached from user-controlled fetch, and hostname patterns
 * that mark a host as local / internal / in-cluster.
 *
 * Pure data, no runtime side effects, no `import "server-only"`. Two
 * consumers today:
 *
 *   1. `lib/safe-fetch.ts` (and transitively `lib/db/connection-host-guard.ts`)
 *      builds a `node:net` BlockList and a Set of host patterns from
 *      these arrays at module load time.
 *
 *   2. `lib/sandbox/child-source.ts` interpolates these values into the
 *      sandbox grandchild's template literal via `JSON.stringify`. The
 *      grandchild runs in a separate `node -e` subprocess with no
 *      access to npm or the rest of the codebase, so the data has to
 *      cross the process boundary as inlined literals; consuming from
 *      this module at template-render time keeps that inlined copy
 *      automatically in sync.
 *
 * Adding a new range:
 *   - IPv4 prefix:           append to `SSRF_IPV4_CIDRS`
 *   - IPv4 single address:   append to `SSRF_IPV4_BROADCAST_ADDRESSES`
 *   - IPv6 prefix:           append to `SSRF_IPV6_CIDRS`
 *   - IPv6 single address:   append to `SSRF_IPV6_LITERAL_ADDRESSES`
 *   - Hostname exact match:  append to `SSRF_BLOCKED_HOST_EXACT`
 *   - Hostname suffix:       append to `SSRF_BLOCKED_HOST_SUFFIXES` with leading `.`
 *
 * Note: `SSRF_NAT64_PREFIX_CIDR` (64:ff9b::/96) is intentionally NOT in
 * `SSRF_IPV6_CIDRS`. In dual-stack networks resolvers synthesise this
 * prefix for every IPv4-only public host; blanket-blocking it would
 * block legitimate destinations. Consumers handle this prefix specially
 * by extracting the embedded IPv4 and rechecking it against the IPv4
 * list. Site-local NAT64 (64:ff9b:1::/48, RFC 8215) IS in the regular
 * list because by-construction the embedded IPv4 maps to internal infra.
 */

export type Cidr = readonly [address: string, prefix: number];

/**
 * Covers unspecified, RFC 1918 private, loopback, CGNAT (RFC 6598),
 * link-local incl. cloud IMDS (169.254.169.254), IETF protocol
 * assignments, IPv4 documentation ranges, benchmarking, multicast,
 * reserved future use. Broadcast is in `SSRF_IPV4_BROADCAST_ADDRESSES`.
 */
export const SSRF_IPV4_CIDRS: readonly Cidr[] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

export const SSRF_IPV4_BROADCAST_ADDRESSES: readonly string[] = [
  "255.255.255.255",
];

/**
 * IPv6 ranges. Site-local NAT64 (64:ff9b:1::/48, RFC 8215) and
 * deprecated transition mechanisms (Teredo 2001::/32, 6to4 2002::/16)
 * are blanket-blocked here despite carrying embedded IPv4: the RFC
 * 8215 prefix is by-construction site-local, and Teredo / 6to4 are
 * deprecated and not synthesised by mainstream resolvers, so the
 * false-positive risk is low.
 *
 * `::ffff:0:0/96` (IPv4-mapped) is NOT in this list because Node's
 * BlockList treats it as "all IPv4" - consumers handle IPv4-mapped via
 * an embedded-IPv4 extraction instead. Same shape applies to
 * `64:ff9b::/96` (well-known NAT64) - see `SSRF_NAT64_PREFIX_CIDR`.
 */
export const SSRF_IPV6_CIDRS: readonly Cidr[] = [
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
];

export const SSRF_IPV6_LITERAL_ADDRESSES: readonly string[] = ["::", "::1"];

/**
 * NAT64 well-known prefix (RFC 6052). Kept separate from
 * `SSRF_IPV6_CIDRS` because it must be handled specially - the last 32
 * bits encode an IPv4 destination that may be a legitimate public
 * address. Consumers detect membership in this prefix, extract the
 * embedded IPv4, and recheck it against the IPv4 list.
 */
export const SSRF_NAT64_PREFIX_CIDR: Cidr = ["64:ff9b::", 96];

/**
 * Hostnames matched exactly (case-insensitive, trailing dot stripped)
 * before any DNS resolution.
 */
export const SSRF_BLOCKED_HOST_EXACT: readonly string[] = ["localhost"];

/**
 * Hostname suffixes matched (case-insensitive, trailing dot stripped)
 * before any DNS resolution. Each entry begins with `.` so a top-level
 * token like "internal" cannot match an unrelated host such as
 * "myinternal.com".
 *
 * `*.local` covers mDNS / Bonjour and is a superset of the Kubernetes
 * patterns, but the cluster suffixes are listed explicitly so the
 * intent is visible at the denylist site and so any future narrowing
 * of `.local` (e.g. to mDNS-only) does not silently re-open the
 * in-cluster path.
 *
 * Cluster suffix scope: KeeperHub staging and production both run on
 * AWS EKS with the default `clusterDomain` of `cluster.local`. If we
 * move to a cluster with a custom `clusterDomain`, add it here.
 */
export const SSRF_BLOCKED_HOST_SUFFIXES: readonly string[] = [
  ".local",
  ".internal",
  ".svc.cluster.local",
  ".pod.cluster.local",
];
