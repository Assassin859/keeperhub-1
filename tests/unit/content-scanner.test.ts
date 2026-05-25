import { afterEach, describe, expect, it, vi } from "vitest";

const captureMessageMock = vi.fn();
vi.mock("@sentry/nextjs", () => ({
  captureMessage: (message: string, context: unknown): void => {
    captureMessageMock(message, context);
  },
}));

const { scanNodes, scanAndReport } = await import(
  "@/lib/security/content-scanner"
);

afterEach(() => {
  captureMessageMock.mockReset();
});

type Hit = {
  pattern: string;
  nodeId: string;
  nodeType: string;
  jsonPath: string;
};

function node(
  id: string,
  config: unknown,
  type = "action"
): {
  id: string;
  data: { type: string; config: unknown };
} {
  return { id, data: { type, config } };
}

describe("scanNodes — pattern matches", () => {
  it("detects the IMDS metadata IP in a URL", () => {
    const hits = scanNodes([
      node("n1", { endpoint: "http://169.254.169.254/latest/meta-data/" }),
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      pattern: "imds_metadata_ip",
      nodeId: "n1",
      jsonPath: "n1.config.endpoint",
    });
  });

  it("detects information_schema (case-insensitive)", () => {
    const hits = scanNodes([
      node("n1", { query: "SELECT * FROM INFORMATION_SCHEMA.tables" }),
    ]);
    expect(hits.map((h: Hit) => h.pattern)).toContain("pg_information_schema");
  });

  it("detects pg_catalog (case-insensitive)", () => {
    const hits = scanNodes([
      node("n1", { query: "SELECT * FROM pg_catalog.pg_user" }),
    ]);
    expect(hits.map((h: Hit) => h.pattern)).toContain("pg_catalog");
  });

  it("detects neon_auth in nested object", () => {
    // Real-world shape: SQL touching Neon's auth schema. Underscores count
    // as word chars so the boundary fires on the `.` after `auth`, not
    // mid-token in something like `neon_authentication`.
    const hits = scanNodes([
      node("n1", { query: "SELECT * FROM neon_auth.users_sync" }),
    ]);
    expect(hits[0]).toMatchObject({
      pattern: "neon_auth",
      jsonPath: "n1.config.query",
    });
  });

  it("detects refresh_token in an array element", () => {
    const hits = scanNodes([
      node("n1", { body: ["client_id=abc", "grant_type=refresh_token"] }),
    ]);
    expect(hits.map((h: Hit) => h.pattern)).toContain("refresh_token");
    expect(hits[0].jsonPath).toBe("n1.config.body[1]");
  });

  it("detects client_secret", () => {
    const hits = scanNodes([node("n1", { body: "client_secret=topsecret" })]);
    expect(hits.map((h: Hit) => h.pattern)).toContain("client_secret");
  });

  it("detects DATABASE_URL exactly (case-sensitive)", () => {
    const hits = scanNodes([node("n1", { template: "{{env.DATABASE_URL}}" })]);
    expect(hits.map((h: Hit) => h.pattern)).toContain("database_url");
  });

  it("does NOT match lowercase database_url (case-sensitive)", () => {
    const hits = scanNodes([
      node("n1", { description: "the database_url field is not flagged" }),
    ]);
    expect(hits.map((h: Hit) => h.pattern)).not.toContain("database_url");
  });
});

describe("scanNodes — non-matches and edge cases", () => {
  it("returns empty for benign config", () => {
    expect(
      scanNodes([
        node("n1", { name: "Send Discord message", channel: "#general" }),
      ])
    ).toEqual([]);
  });

  it("skips nodes with null/undefined config", () => {
    expect(scanNodes([node("n1", null), node("n2", undefined)])).toEqual([]);
  });

  it("does not match information_schema substring without word boundary", () => {
    const hits = scanNodes([node("n1", { name: "myinformation_schemaXXX" })]);
    expect(hits.map((h: Hit) => h.pattern)).not.toContain(
      "pg_information_schema"
    );
  });

  it("handles deeply nested structures", () => {
    const hits = scanNodes([
      node("n1", {
        request: {
          options: {
            params: ["safe", { secret: "client_secret=abc" }],
          },
        },
      }),
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0].jsonPath).toBe("n1.config.request.options.params[1].secret");
  });

  it("captures multiple distinct (node, pattern) hits across nodes", () => {
    const hits = scanNodes([
      node("n1", { endpoint: "http://169.254.169.254/" }),
      node("n2", { query: "SELECT * FROM pg_catalog.x" }),
    ]);
    expect(hits.map((h: Hit) => `${h.nodeId}:${h.pattern}`)).toEqual([
      "n1:imds_metadata_ip",
      "n2:pg_catalog",
    ]);
  });
});

describe("scanAndReport", () => {
  it("emits one Sentry event with deduped hits when matches exist", () => {
    scanAndReport(
      [
        node("n1", {
          a: "169.254.169.254",
          b: "169.254.169.254 also here",
        }),
      ],
      { workflowId: "wf_1", executionId: "exec_1", organizationId: "org_1" }
    );
    expect(captureMessageMock).toHaveBeenCalledTimes(1);
    const [message, options] = captureMessageMock.mock.calls[0] as [
      string,
      { extra: { hitCount: number; hits: Hit[] } },
    ];
    expect(message).toBe("security.content_scanner_hit");
    // Two textual matches in n1.config.* under same (nodeId, pattern) -> deduped to one
    expect(options.extra.hitCount).toBe(1);
    expect(options.extra.hits).toHaveLength(1);
    expect(options.extra.hits[0].pattern).toBe("imds_metadata_ip");
  });

  it("does not emit when there are no hits", () => {
    scanAndReport([node("n1", { name: "Send Discord" })], {
      workflowId: "wf_2",
    });
    expect(captureMessageMock).not.toHaveBeenCalled();
  });

  it("never includes the matched value in the Sentry payload", () => {
    scanAndReport(
      [node("n1", { secret: "client_secret=THIS_IS_THE_SECRET_VALUE" })],
      { workflowId: "wf_3" }
    );
    const payloadJson = JSON.stringify(captureMessageMock.mock.calls[0][1]);
    expect(payloadJson).not.toContain("THIS_IS_THE_SECRET_VALUE");
    expect(payloadJson).toContain("client_secret"); // pattern name only
  });

  it("swallows Sentry transport failure (best-effort capture)", () => {
    captureMessageMock.mockImplementationOnce(() => {
      throw new Error("sentry down");
    });
    expect(() =>
      scanAndReport([node("n1", { endpoint: "http://169.254.169.254/" })], {
        workflowId: "wf_4",
      })
    ).not.toThrow();
  });
});
