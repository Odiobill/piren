import { describe, expect, it } from "vitest";
import {
  parsePackageManifest,
  mergeEffectivePackages,
  diagnosePackages,
  type EffectivePackage,
  type DiagnosedPackage,
  type PackageManifest,
} from "../src/package-manifest.js";

describe("parsePackageManifest", () => {
  it("parses a valid package manifest YAML", () => {
    const yaml = [
      "type: Package Manifest",
      "required:",
      "  - \"@piren/git-tools\"",
      "recommended:",
      "  - \"@piren/web-search\"",
    ].join("\n");

    const manifest = parsePackageManifest(yaml);
    expect(manifest).toEqual({
      type: "Package Manifest",
      required: ["@piren/git-tools"],
      recommended: ["@piren/web-search"],
    });
  });

  it("returns empty arrays when no packages declared", () => {
    const yaml = ["type: Package Manifest"].join("\n");

    const manifest = parsePackageManifest(yaml);
    expect(manifest).toEqual({
      type: "Package Manifest",
      required: [],
      recommended: [],
    });
  });

  it("handles YAML with only recommended", () => {
    const yaml = [
      "type: Package Manifest",
      "recommended:",
      "  - \"@piren/web-search\"",
      "  - \"@piren/code-review\"",
    ].join("\n");

    const manifest = parsePackageManifest(yaml);
    expect(manifest).toEqual({
      type: "Package Manifest",
      required: [],
      recommended: ["@piren/web-search", "@piren/code-review"],
    });
  });

  it("handles empty YAML input", () => {
    const manifest = parsePackageManifest("");
    expect(manifest.required).toEqual([]);
    expect(manifest.recommended).toEqual([]);
  });

  it("handles malformed YAML gracefully with empty defaults", () => {
    const manifest = parsePackageManifest("not: [valid: yaml");
    expect(manifest.required).toEqual([]);
    expect(manifest.recommended).toEqual([]);
  });
});

describe("mergeEffectivePackages", () => {
  it("merges shared, group, and agent manifests deterministically", () => {
    const manifests: { source: { kind: "shared" } | { kind: "group"; group: string } | { kind: "agent"; agent: string }; manifest: PackageManifest }[] = [
      {
        source: { kind: "shared" },
        manifest: { type: "Package Manifest", required: ["shared-req"], recommended: ["shared-rec"] },
      },
      {
        source: { kind: "group", group: "devs" },
        manifest: { type: "Package Manifest", required: ["group-req"], recommended: [] },
      },
      {
        source: { kind: "agent", agent: "dipu" },
        manifest: { type: "Package Manifest", required: [], recommended: ["agent-rec"] },
      },
    ];

    const effective = mergeEffectivePackages(manifests);
    expect(effective).toEqual([
      { name: "shared-req", required: true, source: { kind: "shared" } },
      { name: "shared-rec", required: false, source: { kind: "shared" } },
      { name: "group-req", required: true, source: { kind: "group", group: "devs" } },
      { name: "agent-rec", required: false, source: { kind: "agent", agent: "dipu" } },
    ]);
  });

  it("agent manifest overrides duplicate packages (last wins)", () => {
    const manifests: { source: { kind: "shared" } | { kind: "agent"; agent: string }; manifest: PackageManifest }[] = [
      {
        source: { kind: "shared" },
        manifest: { type: "Package Manifest", required: ["shared-pkg"], recommended: ["shared-rec"] },
      },
      {
        source: { kind: "agent", agent: "dipu" },
        manifest: { type: "Package Manifest", required: ["shared-pkg"], recommended: [] },
      },
    ];

    const effective = mergeEffectivePackages(manifests);
    // shared-pkg appears once, from the agent source (last-writer wins).
    // Declaration order is preserved: shared.required comes before shared.recommended.
    expect(effective).toEqual([
      { name: "shared-pkg", required: true, source: { kind: "agent", agent: "dipu" } },
      { name: "shared-rec", required: false, source: { kind: "shared" } },
    ]);
  });

  it("handles empty manifest list", () => {
    const effective = mergeEffectivePackages([]);
    expect(effective).toEqual([]);
  });

  it("deduplicates by name, preserving last declaration", () => {
    const manifests: { source: { kind: "shared" }; manifest: PackageManifest }[] = [
      {
        source: { kind: "shared" },
        manifest: { type: "Package Manifest", required: ["dupe-pkg"], recommended: ["dupe-pkg"] },
      },
    ];

    const effective = mergeEffectivePackages(manifests);
    // Last entry for dupe-pkg is "recommended" from the last manifest's recommended list
    expect(effective).toEqual([
      { name: "dupe-pkg", required: false, source: { kind: "shared" } },
    ]);
  });

  it("preserves merge order: shared -> groups -> agent", () => {
    // Even if we pass them in a different order, the function processes them
    // in declaration order (caller responsibility). This test verifies that
    // two groups are processed in the order they appear.
    const manifests: { source: { kind: "group"; group: string }; manifest: PackageManifest }[] = [
      {
        source: { kind: "group", group: "a-team" },
        manifest: { type: "Package Manifest", required: ["pkg-a"], recommended: [] },
      },
      {
        source: { kind: "group", group: "b-team" },
        manifest: { type: "Package Manifest", required: [], recommended: ["pkg-a"] },
      },
    ];

    const effective = mergeEffectivePackages(manifests);
    expect(effective).toEqual([
      { name: "pkg-a", required: false, source: { kind: "group", group: "b-team" } },
    ]);
  });
});

describe("diagnosePackages", () => {
  const makePackageInstalled = (installed: string[]): ((name: string) => boolean) => {
    return (name: string) => installed.includes(name);
  };

  it("reports required package missing from local config", () => {
    const effective: EffectivePackage[] = [
      { name: "@piren/git-tools", required: true, source: { kind: "shared" } },
    ];

    const diagnosed = diagnosePackages(effective, [], makePackageInstalled([]));
    expect(diagnosed).toEqual([
      {
        name: "@piren/git-tools",
        required: true,
        source: { kind: "shared" },
        state: "missing-from-local-config",
        detail: "not declared in local config packages list",
      },
    ]);
  });

  it("reports required package declared but not installed", () => {
    const effective: EffectivePackage[] = [
      { name: "@piren/git-tools", required: true, source: { kind: "shared" } },
    ];

    const diagnosed = diagnosePackages(effective, ["@piren/git-tools"], makePackageInstalled([]));
    expect(diagnosed).toEqual([
      {
        name: "@piren/git-tools",
        required: true,
        source: { kind: "shared" },
        state: "declared-but-not-installed",
        detail: "declared in local config but require.resolve failed",
      },
    ]);
  });

  it("reports required package as ok-required when installed", () => {
    const effective: EffectivePackage[] = [
      { name: "@piren/git-tools", required: true, source: { kind: "shared" } },
    ];

    const diagnosed = diagnosePackages(effective, ["@piren/git-tools"], makePackageInstalled(["@piren/git-tools"]));
    expect(diagnosed).toEqual([
      {
        name: "@piren/git-tools",
        required: true,
        source: { kind: "shared" },
        state: "ok-required",
        detail: "installed",
      },
    ]);
  });

  it("reports recommended package missing from local config as recommended-missing", () => {
    const effective: EffectivePackage[] = [
      { name: "@piren/web-search", required: false, source: { kind: "shared" } },
    ];

    const diagnosed = diagnosePackages(effective, [], makePackageInstalled([]));
    expect(diagnosed).toEqual([
      {
        name: "@piren/web-search",
        required: false,
        source: { kind: "shared" },
        state: "recommended-missing",
        detail: "recommended package not in local config",
      },
    ]);
  });

  it("reports recommended package as ok-recommended when installed", () => {
    const effective: EffectivePackage[] = [
      { name: "@piren/web-search", required: false, source: { kind: "shared" } },
    ];

    const diagnosed = diagnosePackages(
      effective,
      ["@piren/web-search"],
      makePackageInstalled(["@piren/web-search"]),
    );
    expect(diagnosed).toEqual([
      {
        name: "@piren/web-search",
        required: false,
        source: { kind: "shared" },
        state: "ok-recommended",
        detail: "installed",
      },
    ]);
  });

  it("handles mixed required and recommended packages", () => {
    const effective: EffectivePackage[] = [
      { name: "req-missing-local", required: true, source: { kind: "shared" } },
      { name: "req-missing-install", required: true, source: { kind: "group", group: "devs" } },
      { name: "req-ok", required: true, source: { kind: "agent", agent: "dipu" } },
      { name: "rec-missing", required: false, source: { kind: "shared" } },
      { name: "rec-ok", required: false, source: { kind: "agent", agent: "dipu" } },
    ];

    const diagnosed = diagnosePackages(
      effective,
      ["req-missing-install", "req-ok", "rec-ok"],
      makePackageInstalled(["req-ok", "rec-ok"]),
    );

    expect(diagnosed).toEqual([
      { name: "req-missing-local", required: true, source: { kind: "shared" }, state: "missing-from-local-config", detail: "not declared in local config packages list" },
      { name: "req-missing-install", required: true, source: { kind: "group", group: "devs" }, state: "declared-but-not-installed", detail: "declared in local config but require.resolve failed" },
      { name: "req-ok", required: true, source: { kind: "agent", agent: "dipu" }, state: "ok-required", detail: "installed" },
      { name: "rec-missing", required: false, source: { kind: "shared" }, state: "recommended-missing", detail: "recommended package not in local config" },
      { name: "rec-ok", required: false, source: { kind: "agent", agent: "dipu" }, state: "ok-recommended", detail: "installed" },
    ]);
  });

  it("returns empty array for empty effective packages", () => {
    const diagnosed = diagnosePackages([], [], makePackageInstalled([]));
    expect(diagnosed).toEqual([]);
  });

  it("reports recommended package declared in local config but not installed as declared-but-not-installed", () => {
    // A recommended package that someone put in their local config but forgot to install
    const effective: EffectivePackage[] = [
      { name: "@piren/optional-tool", required: false, source: { kind: "shared" } },
    ];

    const diagnosed = diagnosePackages(
      effective,
      ["@piren/optional-tool"],
      makePackageInstalled([]),
    );
    expect(diagnosed).toEqual([
      {
        name: "@piren/optional-tool",
        required: false,
        source: { kind: "shared" },
        state: "declared-but-not-installed",
        detail: "declared in local config but require.resolve failed",
      },
    ]);
  });

  it("reports a required package as blocked-by-policy when it appears in the blocked list", () => {
    const effective: EffectivePackage[] = [
      { name: "@piren/blocked-tool", required: true, source: { kind: "shared" } },
    ];

    const diagnosed = diagnosePackages(effective, [], makePackageInstalled([]), ["@piren/blocked-tool"]);
    expect(diagnosed).toEqual([
      {
        name: "@piren/blocked-tool",
        required: true,
        source: { kind: "shared" },
        state: "blocked-by-policy",
        detail: "blocked by local package_policy",
      },
    ]);
  });

  it("reports a recommended package as blocked-by-policy when blocked", () => {
    const effective: EffectivePackage[] = [
      { name: "@piren/blocked-rec", required: false, source: { kind: "shared" } },
    ];

    const diagnosed = diagnosePackages(effective, [], makePackageInstalled([]), ["@piren/blocked-rec"]);
    expect(diagnosed).toEqual([
      {
        name: "@piren/blocked-rec",
        required: false,
        source: { kind: "shared" },
        state: "blocked-by-policy",
        detail: "blocked by local package_policy",
      },
    ]);
  });

  it("blocked-by-policy takes precedence even when package is in local config and installed", () => {
    const effective: EffectivePackage[] = [
      { name: "@piren/blocked-but-declared", required: true, source: { kind: "shared" } },
    ];

    const diagnosed = diagnosePackages(
      effective,
      ["@piren/blocked-but-declared"],
      makePackageInstalled(["@piren/blocked-but-declared"]),
      ["@piren/blocked-but-declared"],
    );
    expect(diagnosed).toEqual([
      {
        name: "@piren/blocked-but-declared",
        required: true,
        source: { kind: "shared" },
        state: "blocked-by-policy",
        detail: "blocked by local package_policy",
      },
    ]);
  });

  it("does not trigger blocked-by-policy when blocked list is empty", () => {
    const effective: EffectivePackage[] = [
      { name: "@piren/not-blocked", required: true, source: { kind: "shared" } },
    ];

    const diagnosed = diagnosePackages(effective, [], makePackageInstalled([]), []);
    expect(diagnosed).toEqual([
      {
        name: "@piren/not-blocked",
        required: true,
        source: { kind: "shared" },
        state: "missing-from-local-config",
        detail: "not declared in local config packages list",
      },
    ]);
  });

  it("does not trigger blocked-by-policy when blockedPackages is undefined", () => {
    const effective: EffectivePackage[] = [
      { name: "@piren/not-blocked", required: true, source: { kind: "shared" } },
    ];

    const diagnosed = diagnosePackages(effective, [], makePackageInstalled([]));
    expect(diagnosed).toEqual([
      {
        name: "@piren/not-blocked",
        required: true,
        source: { kind: "shared" },
        state: "missing-from-local-config",
        detail: "not declared in local config packages list",
      },
    ]);
  });
});
