import { describe, expect, it } from "vitest";
import { resolvePackages, type PackageEntryResolver } from "../src/packages.js";

describe("package resolution (ADR-0013)", () => {
  it("resolves all declared packages to their entry points", () => {
    const fakeResolver: PackageEntryResolver = (name) => `/fake/node_modules/${name}/dist/index.js`;
    const result = resolvePackages(["@piren/web-search", "@piren/git-tools"], fakeResolver);

    expect(result.resolved).toEqual([
      { name: "@piren/web-search", path: "/fake/node_modules/@piren/web-search/dist/index.js" },
      { name: "@piren/git-tools", path: "/fake/node_modules/@piren/git-tools/dist/index.js" },
    ]);
    expect(result.missing).toEqual([]);
    expect(result.checks).toHaveLength(2);
    expect(result.checks.every((c) => c.installed)).toBe(true);
  });

  it("collects missing packages that throw on resolve without crashing", () => {
    const fakeResolver: PackageEntryResolver = (name) => {
      if (name === "@piren/missing") throw new Error("Cannot find module '@piren/missing'");
      return `/fake/node_modules/${name}/index.js`;
    };
    const result = resolvePackages(["@piren/web-search", "@piren/missing"], fakeResolver);

    expect(result.resolved).toEqual([{ name: "@piren/web-search", path: "/fake/node_modules/@piren/web-search/index.js" }]);
    expect(result.missing).toEqual(["@piren/missing"]);
    expect(result.checks).toContainEqual(
      expect.objectContaining({ name: "@piren/missing", installed: false, error: expect.stringContaining("Cannot find module") }),
    );
  });

  it("returns empty results for an empty package list", () => {
    const fakeResolver: PackageEntryResolver = () => "/fake/index.js";
    const result = resolvePackages([], fakeResolver);

    expect(result.resolved).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.checks).toEqual([]);
  });

  it("preserves declaration order in resolved packages", () => {
    const fakeResolver: PackageEntryResolver = (name) => `/fake/${name}.js`;
    const result = resolvePackages(["c-pkg", "a-pkg", "b-pkg"], fakeResolver);

    expect(result.resolved.map((p) => p.name)).toEqual(["c-pkg", "a-pkg", "b-pkg"]);
  });

  it("includes the resolved path in each check", () => {
    const fakeResolver: PackageEntryResolver = (name) => `/fake/${name}/entry.js`;
    const result = resolvePackages(["my-pkg"], fakeResolver);

    expect(result.checks[0]?.path).toBe("/fake/my-pkg/entry.js");
  });
});
