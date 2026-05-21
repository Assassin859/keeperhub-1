import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { SANDBOX_CHILD_SOURCE } from "@/lib/sandbox/child-source";
import {
  SSRF_BLOCKED_HOST_EXACT,
  SSRF_BLOCKED_HOST_SUFFIXES,
  SSRF_IPV4_BROADCAST_ADDRESSES,
  SSRF_IPV4_CIDRS,
  SSRF_IPV6_CIDRS,
  SSRF_IPV6_LITERAL_ADDRESSES,
  SSRF_NAT64_PREFIX_CIDR,
} from "@/lib/ssrf-blocklist";

// The sandbox grandchild runs as a separate `node -e <SANDBOX_CHILD_SOURCE>`
// subprocess with no access to npm or the rest of the codebase, so the SSRF
// blocklist has to cross the process boundary as inlined literals
// (`JSON.stringify` interpolation at template-render time). This test locks
// that contract: every entry in lib/ssrf-blocklist.ts must appear in the
// rendered source. If someone later regresses by hardcoding the list in
// child-source.ts and forgetting to update one consumer, this test fails.
describe("sandbox child-source consumes lib/ssrf-blocklist.ts", () => {
  it("inlines every IPv4 CIDR address from the SoT", () => {
    for (const [addr] of SSRF_IPV4_CIDRS) {
      expect(SANDBOX_CHILD_SOURCE).toContain(`"${addr}"`);
    }
  });

  it("inlines every IPv4 broadcast address from the SoT", () => {
    for (const addr of SSRF_IPV4_BROADCAST_ADDRESSES) {
      expect(SANDBOX_CHILD_SOURCE).toContain(`"${addr}"`);
    }
  });

  it("inlines every IPv6 CIDR address from the SoT", () => {
    for (const [addr] of SSRF_IPV6_CIDRS) {
      expect(SANDBOX_CHILD_SOURCE).toContain(`"${addr}"`);
    }
  });

  it("inlines every IPv6 literal address from the SoT", () => {
    for (const addr of SSRF_IPV6_LITERAL_ADDRESSES) {
      expect(SANDBOX_CHILD_SOURCE).toContain(`"${addr}"`);
    }
  });

  it("inlines the NAT64 well-known prefix address from the SoT", () => {
    expect(SANDBOX_CHILD_SOURCE).toContain(`"${SSRF_NAT64_PREFIX_CIDR[0]}"`);
  });

  it("inlines every blocked-host exact match from the SoT", () => {
    for (const host of SSRF_BLOCKED_HOST_EXACT) {
      expect(SANDBOX_CHILD_SOURCE).toContain(`"${host}"`);
    }
  });

  it("inlines every blocked-host suffix from the SoT", () => {
    for (const suffix of SSRF_BLOCKED_HOST_SUFFIXES) {
      expect(SANDBOX_CHILD_SOURCE).toContain(`"${suffix}"`);
    }
  });

  it("renders syntactically valid JavaScript", async () => {
    // `node -e` parses the source at process start. If the template literal
    // ever produces invalid JS (e.g. an interpolation breaks a string
    // boundary or yields a reserved-word identifier), every Code-node
    // workflow run would crash at startup. Use Node's vm.Script to do a
    // parse-only check without executing anything.
    const { Script } = await import("node:vm");
    expect(() => new Script(SANDBOX_CHILD_SOURCE)).not.toThrow();
  });
});
