import { describe, expect, it } from "vitest";
import { updateServiceStatusYaml } from "../src/service-lifecycle.js";

describe("updateServiceStatusYaml", () => {
  it("appends a services block to a config with no existing services block", () => {
    const input = "vault_root: /srv/vault\nallowed_agents:\n  - piren\n";
    const result = updateServiceStatusYaml(input, "gateway", { installed: true, running: true });
    expect(result).toContain("vault_root: /srv/vault");
    expect(result).toContain("services:");
    expect(result).toContain("gateway:");
    expect(result).toContain("installed: true");
    expect(result).toContain("running: true");
  });

  it("merges into an existing services block without duplicating it", () => {
    const input = [
      "vault_root: /srv/vault",
      "allowed_agents:",
      "  - piren",
      "services:",
      "  transports:",
      "    gateway:",
      "      installed: true",
      "",
    ].join("\n");
    const result = updateServiceStatusYaml(input, "telegram", { installed: true, running: true });
    const servicesMatches = result.match(/^services:$/gm);
    expect(servicesMatches?.length ?? 0).toBe(1);
    expect(result).toContain("telegram:");
    expect(result).toContain("gateway:");
  });

  it("updates an existing transport entry in place", () => {
    const input = [
      "vault_root: /srv/vault",
      "services:",
      "  transports:",
      "    gateway:",
      "      installed: false",
      "",
    ].join("\n");
    const result = updateServiceStatusYaml(input, "gateway", { installed: true, running: true });
    expect(result).not.toContain("installed: false");
    expect(result).toContain("installed: true");
  });

  it("writes installed:false on remove", () => {
    const input = "vault_root: /srv/vault\n";
    const result = updateServiceStatusYaml(input, "gateway", { installed: false, running: false });
    expect(result).toContain("installed: false");
  });

  it("preserves unrelated config keys", () => {
    const input = [
      "vault_root: /srv/vault",
      "allowed_agents:",
      "  - piren",
      "packages:",
      "  - \"@piren/web-search\"",
      "",
    ].join("\n");
    const result = updateServiceStatusYaml(input, "gateway", { installed: true });
    expect(result).toContain("@piren/web-search");
    expect(result).toContain("vault_root: /srv/vault");
    expect(result).toContain("services:");
  });
});
