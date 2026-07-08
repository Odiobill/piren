import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkServiceConfig, type ServiceConfig } from "../src/doctor.js";

describe("checkServiceConfig", () => {
  it("returns null when no services block is declared", () => {
    expect(checkServiceConfig(undefined)).toBeNull();
    expect(checkServiceConfig({})).toBeNull();
  });

  it("returns null when the services block is empty", () => {
    expect(checkServiceConfig({ transports: {} })).toBeNull();
  });

  it("warns when a transport is declared but its installed flag is false", () => {
    const result = checkServiceConfig({ transports: { gateway: { installed: false } } });
    expect(result).not.toBeNull();
    expect(result!.status).toBe("warn");
    expect(result!.message).toContain("gateway");
    expect(result!.message).toMatch(/not installed|run.*piren service install/i);
  });

  it("is ok when all declared transports are installed", () => {
    const result = checkServiceConfig({
      transports: {
        gateway: { installed: true },
        telegram: { installed: true },
      },
    });
    expect(result).not.toBeNull();
    expect(result!.status).toBe("ok");
    expect(result!.message).toContain("gateway");
    expect(result!.message).toContain("telegram");
  });

  it("warns when a transport is installed but reported as not running", () => {
    const result = checkServiceConfig({ transports: { discord: { installed: true, running: false } } });
    expect(result).not.toBeNull();
    expect(result!.status).toBe("warn");
    expect(result!.message).toContain("discord");
    expect(result!.message).toMatch(/not running/i);
  });

  it("is ok when an installed transport is running", () => {
    const result = checkServiceConfig({ transports: { gateway: { installed: true, running: true } } });
    expect(result!.status).toBe("ok");
  });

  it("ignores transports set to explicitly false (disabled)", () => {
    // A transport explicitly disabled (installed: false is the only signal) is
    // still surfaced as a warn, but an empty entry should be skipped.
    expect(checkServiceConfig({ transports: { gateway: {} } })).toBeNull();
  });

  it("handles the scheduler service target and uses wording that fits both transports and scheduler", () => {
    const warnResult = checkServiceConfig({ transports: { scheduler: { installed: false } } });
    expect(warnResult).not.toBeNull();
    expect(warnResult!.status).toBe("warn");
    expect(warnResult!.message).toContain("scheduler");
    // Wording must not call the scheduler a "transport".
    expect(warnResult!.message).not.toMatch(/transport/i);
    expect(warnResult!.message).toMatch(/service target|service/i);

    const okResult = checkServiceConfig({ transports: { scheduler: { installed: true, running: true } } });
    expect(okResult!.status).toBe("ok");
    expect(okResult!.message).toContain("scheduler");
  });

  it("reports both a transport and the scheduler together without misleading wording", () => {
    const result = checkServiceConfig({
      transports: {
        gateway: { installed: true, running: true },
        scheduler: { installed: false },
      },
    });
    expect(result!.status).toBe("warn");
    expect(result!.message).toContain("scheduler");
    expect(result!.message).not.toMatch(/\btransport\b/i);
  });
});
