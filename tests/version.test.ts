import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readVersion } from "../src/version.js";

describe("readVersion", () => {
  it("reads the version field from a package.json path", () => {
    const dir = mkdtempSync(join(tmpdir(), "piren-version-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "piren", version: "0.1.0-rc.1" }),
      );
      expect(readVersion(join(dir, "package.json"))).toBe("0.1.0-rc.1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a fallback when the file is missing", () => {
    // A released binary must not crash if package.json cannot be located.
    // It reports a clearly-marked unknown version instead.
    expect(readVersion(join(tmpdir(), "piren-no-such-package.json"))).toBe("unknown");
  });

  it("returns a fallback when package.json has no version field", () => {
    const dir = mkdtempSync(join(tmpdir(), "piren-version-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "piren" }));
      expect(readVersion(join(dir, "package.json"))).toBe("unknown");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a fallback when package.json is unparseable", () => {
    const dir = mkdtempSync(join(tmpdir(), "piren-version-"));
    try {
      writeFileSync(join(dir, "package.json"), "{ not valid json");
      expect(readVersion(join(dir, "package.json"))).toBe("unknown");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
