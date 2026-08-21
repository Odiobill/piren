import { afterEach, describe, expect, it, vi } from "vitest";
import { UnauthorizedError, assignInboxTask } from "../web/src/api.js";

/**
 * T1 review correction — actual API-client evidence for `assignInboxTask`
 * over the EXISTING authenticated gateway inbox-create route: POST with the
 * Bearer auth header, exact `{to, title, body}` JSON, success parsing, and
 * 401 UnauthorizedError propagation. No new transport surface is introduced.
 */

const CREATED = {
  taskId: "20260821T210612217Z-check-the-backups",
  path: "team/dipu/inbox/20260821T210612217Z-check-the-backups.md",
  from: "steward",
  to: "dipu",
  status: "pending" as const,
};

function stubFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const fake = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fake);
  return fake;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("assignInboxTask client (existing authenticated inbox-create route)", () => {
  it("POSTs the exact trimmed {to, title, body} JSON with the in-memory Bearer header", async () => {
    const fake = stubFetch(200, CREATED);
    const result = await assignInboxTask("dipu", "  Check the backups  ", "Verify the nightly backup ran.\n", "secret-token");
    expect(result).toEqual(CREATED);
    expect(fake).toHaveBeenCalledTimes(1);
    const [path, init] = fake.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/vault/inbox");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret-token");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      to: "dipu",
      title: "Check the backups",
      body: "Verify the nightly backup ran.",
    });
  });

  it("propagates a 401 as UnauthorizedError (never retried)", async () => {
    stubFetch(401, { error: "unauthorized" });
    await expect(assignInboxTask("dipu", "t", "b", "stale-token")).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("surfaces a bounded server error message on other non-200 responses", async () => {
    stubFetch(400, { error: "title is required" });
    await expect(assignInboxTask("dipu", "   ", "b", "token")).rejects.toThrow("title is required");
  });
});
