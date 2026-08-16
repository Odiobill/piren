import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { buildConversationAgentsResponse, projectConfiguredAgentModels } from "../src/conversation-agents.js";
import { GatewayServer, type GatewayHandle } from "../src/gateway-http.js";
import { initVault } from "../src/init.js";

/**
 * ADR-0043 decommission — Conversation-neutral local-policy roster core.
 * `online` is local installation policy only — membership in this gateway's
 * already-resolved runnableAgents set. It is NOT Pi-process presence,
 * provider reachability, transport state, or identity. The roster is
 * explicitly supplied; no config reread, no directory creation, no probing,
 * no polling.
 */
describe("buildConversationAgentsResponse (pure roster)", () => {
  it("marks only runnable agents online; all other vault-defined names are offline", () => {
    const result = buildConversationAgentsResponse(["piren", "researcher", "heimdall"], ["piren"]);
    expect(result).toEqual({
      agents: [
        { name: "heimdall", online: false },
        { name: "piren", online: true },
        { name: "researcher", online: false },
      ],
    });
  });

  it("sorts deterministically by name", () => {
    const result = buildConversationAgentsResponse(["zeta", "alpha", "mike"], ["alpha"]);
    expect(result.agents.map((agent) => agent.name)).toEqual(["alpha", "mike", "zeta"]);
  });

  it("deduplicates supplied names", () => {
    const result = buildConversationAgentsResponse(["piren", "piren", "thor"], ["piren"]);
    expect(result.agents).toHaveLength(2);
    expect(result.agents.filter((agent) => agent.name === "piren")).toHaveLength(1);
  });

  it("returns an empty roster for an empty vault roster (no invented members)", () => {
    expect(buildConversationAgentsResponse([], ["piren"])).toEqual({ agents: [] });
  });

  it("never adds runnable agents absent from the vault roster (the roster drives membership)", () => {
    const result = buildConversationAgentsResponse(["thor"], ["piren", "thor"]);
    expect(result.agents).toEqual([{ name: "thor", online: true }]);
    expect(result.agents.some((agent) => agent.name === "piren")).toBe(false);
  });
});

/**
 * D5 — configured-model card copy. The roster additively carries each
 * agent's gateway-projected configured model (the declared
 * `team/<agent>/config.yml` model preference in canonical Pi launch
 * formatting), supplied once at gateway startup as an injected input.
 * Absent/malformed configuration projects to null and the field is omitted
 * from the entry — the browser distinguishes it as unavailable; no value is
 * ever invented, read live, or inferred. `online` stays local runnable
 * policy only.
 */
describe("buildConversationAgentsResponse configured model (D5)", () => {
  it("includes the projected configured model only when a usable value exists", () => {
    const result = buildConversationAgentsResponse(
      ["kimi", "dipu", "zora"],
      ["kimi", "dipu"],
      { kimi: "moonshotai/kimi-k2:high", dipu: null, zora: undefined },
    );
    expect(result.agents).toEqual([
      { name: "dipu", online: true },
      { name: "kimi", online: true, model: "moonshotai/kimi-k2:high" },
      { name: "zora", online: false },
    ]);
  });

  it("omits the model field for empty-string values (fail safe, no invented value)", () => {
    const result = buildConversationAgentsResponse(["kimi"], ["kimi"], { kimi: "" });
    expect(result.agents).toEqual([{ name: "kimi", online: true }]);
    expect("model" in (result.agents[0] as object)).toBe(false);
  });

  it("keeps entries model-free when no projection is supplied (back-compat)", () => {
    const result = buildConversationAgentsResponse(["kimi"], ["kimi"]);
    expect(result.agents).toEqual([{ name: "kimi", online: true }]);
  });
});

describe("projectConfiguredAgentModels (D5 startup projection)", () => {
  const deps = (files: Record<string, string>) => ({
    readFile: async (path: string): Promise<string> => {
      if (path in files) return files[path] as string;
      throw new Error("ENOENT: no such file");
    },
  });

  it("projects the declared model preference in canonical Pi launch formatting", async () => {
    const files = {
      [join("/vault", "team", "kimi", "config.yml")]: "model:\n  provider: moonshotai\n  id: kimi-k2\n  thinking: high\n",
      [join("/vault", "team", "dipu", "config.yml")]: "model:\n  id: anthropic/claude-opus-4.6\n",
    };
    const projected = await projectConfiguredAgentModels("/vault", ["kimi", "dipu"], deps(files));
    expect(projected).toEqual({ kimi: "moonshotai/kimi-k2:high", dipu: "anthropic/claude-opus-4.6" });
  });

  it("projects null for a missing config file (best-effort, never throws)", async () => {
    const projected = await projectConfiguredAgentModels("/vault", ["ghost"], deps({}));
    expect(projected).toEqual({ ghost: null });
  });

  it("projects null for malformed YAML content", async () => {
    const files = { [join("/vault", "team", "kimi", "config.yml")]: "model: [unterminated\n" };
    const projected = await projectConfiguredAgentModels("/vault", ["kimi"], deps(files));
    expect(projected).toEqual({ kimi: null });
  });

  it("projects null when the model preference is absent or malformed (no invented value)", async () => {
    const files = {
      [join("/vault", "team", "absent", "config.yml")]: "polling:\n  interval_seconds: 30\n",
      [join("/vault", "team", "scalar", "config.yml")]: "model: 5\n",
      [join("/vault", "team", "emptyid", "config.yml")]: "model:\n  provider: x\n  id: \"\"\n",
    };
    const projected = await projectConfiguredAgentModels("/vault", ["absent", "scalar", "emptyid"], deps(files));
    expect(projected).toEqual({ absent: null, scalar: null, emptyid: null });
  });

  it("reads only team/<agent>/config.yml inside the vault and rejects unexpected names fail-closed", async () => {
    const reads: string[] = [];
    const projected = await projectConfiguredAgentModels("/vault", ["kimi", "../escape", "UPPER"], {
      readFile: async (path: string): Promise<string> => {
        reads.push(path);
        return "model:\n  id: a/b\n";
      },
    });
    expect(projected).toEqual({ kimi: "a/b", "../escape": null, UPPER: null });
    expect(reads).toEqual([join("/vault", "team", "kimi", "config.yml")]);
    expect(reads.every((path) => !path.includes(".."))).toBe(true);
  });

  it("projects null for every agent without a vault root and never touches the filesystem", async () => {
    let readCalled = false;
    const projected = await projectConfiguredAgentModels(undefined, ["kimi"], {
      readFile: async (): Promise<string> => {
        readCalled = true;
        return "";
      },
    });
    expect(projected).toEqual({ kimi: null });
    expect(readCalled).toBe(false);
  });

  it("deduplicates the supplied roster names", async () => {
    let readCount = 0;
    const projected = await projectConfiguredAgentModels("/vault", ["kimi", "kimi"], {
      readFile: async (): Promise<string> => {
        readCount += 1;
        return "model:\n  id: a/b\n";
      },
    });
    expect(projected).toEqual({ kimi: "a/b" });
    expect(readCount).toBe(1);
  });
});

const fakePiScript = join(process.cwd(), "tests", "fixtures", "fake-pi-rpc.cjs");

function fakePiTarget() {
  return {
    command: process.execPath,
    args: [fakePiScript],
    cwd: process.cwd(),
    env: process.env,
  };
}

describe("GET /api/conversation-agents configured model (D5 route)", () => {
  let root: string;
  let server: GatewayServer;
  let handle: GatewayHandle;
  const token = "test-d5-roster-token";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "piren-d5-roster-"));
    await initVault({ vaultRoot: root, agentName: "piren" });
    server = new GatewayServer({
      target: fakePiTarget(),
      vaultRoot: root,
      runnableAgents: ["kimi"],
      vaultAgents: ["kimi", "dipu"],
      targetBuilder: async () => fakePiTarget(),
      authToken: token,
      agentConfiguredModels: { kimi: "moonshotai/kimi-k2:high", dipu: null },
    });
    handle = await server.start();
  });

  afterEach(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  it("serves the additive gateway-projected configured model on the authenticated roster", async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/conversation-agents`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: Array<Record<string, unknown>> };
    expect(body.agents).toEqual([
      { name: "dipu", online: false },
      { name: "kimi", online: true, model: "moonshotai/kimi-k2:high" },
    ]);
    expect("model" in (body.agents[0] as object)).toBe(false);
  });
});
