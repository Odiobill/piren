import { describe, expect, it } from "vitest";
import {
  DISCORD_APPLICATION_COMMANDS,
  planCommandRegistration,
  registerApplicationCommands,
  maybeRegisterApplicationCommands,
  parseInteractionCommand,
  type DiscordApplicationCommandApi,
  type RegisteredCommandRef,
} from "../src/discord-commands.js";

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

describe("DISCORD_APPLICATION_COMMANDS manifest", () => {
  it("defines exactly the five ADR-0040 commands as chat-input commands", () => {
    expect(DISCORD_APPLICATION_COMMANDS.map((c) => c.name)).toEqual(["start", "agents", "agent", "whoami", "abort"]);
    for (const command of DISCORD_APPLICATION_COMMANDS) {
      expect(command.type).toBe(1);
      expect(command.description.length).toBeGreaterThan(0);
    }
  });

  it("gives /agent exactly one required string option named 'name'", () => {
    const agent = DISCORD_APPLICATION_COMMANDS.find((c) => c.name === "agent");
    expect(agent?.options).toHaveLength(1);
    expect(agent?.options?.[0]?.name).toBe("name");
    expect(agent?.options?.[0]?.type).toBe(3); // STRING
    expect(agent?.options?.[0]?.required).toBe(true);
  });

  it("gives the other four commands no options", () => {
    for (const command of DISCORD_APPLICATION_COMMANDS) {
      if (command.name === "agent") continue;
      expect(command.options ?? []).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Registration planning (narrow per-command create/update; never destructive)
// ---------------------------------------------------------------------------

describe("planCommandRegistration", () => {
  it("creates every command when none are registered", () => {
    const actions = planCommandRegistration([], DISCORD_APPLICATION_COMMANDS);
    expect(actions).toHaveLength(5);
    expect(actions.every((a) => a.kind === "create")).toBe(true);
  });

  it("updates commands whose names already exist and creates the rest", () => {
    const existing: RegisteredCommandRef[] = [
      { id: "cmd-1", name: "start" },
      { id: "cmd-2", name: "agents" },
    ];
    const actions = planCommandRegistration(existing, DISCORD_APPLICATION_COMMANDS);
    const updates = actions.filter((a) => a.kind === "update");
    const creates = actions.filter((a) => a.kind === "create");
    expect(updates.map((a) => (a.kind === "update" ? a.commandId : ""))).toEqual(["cmd-1", "cmd-2"]);
    expect(creates.map((a) => a.spec.name)).toEqual(["agent", "whoami", "abort"]);
  });

  it("never produces delete actions or touches unrelated existing commands", () => {
    const existing: RegisteredCommandRef[] = [{ id: "cmd-9", name: "someone-elses-command" }];
    const actions = planCommandRegistration(existing, DISCORD_APPLICATION_COMMANDS);
    expect(actions).toHaveLength(5);
    expect(actions.every((a) => a.kind === "create" || a.kind === "update")).toBe(true);
    expect(actions.some((a) => a.kind === "update" && a.commandId === "cmd-9")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Registration coordinator + HTTP adapter
// ---------------------------------------------------------------------------

function fakeRegistrationApi(existing: RegisteredCommandRef[]) {
  const calls: Array<{ method: string; applicationId: string; commandId?: string; specName?: string }> = [];
  const api: DiscordApplicationCommandApi = {
    async listApplicationCommands(applicationId) {
      calls.push({ method: "list", applicationId });
      return existing;
    },
    async createApplicationCommand(applicationId, spec) {
      calls.push({ method: "create", applicationId, specName: spec.name });
    },
    async updateApplicationCommand(applicationId, commandId, spec) {
      calls.push({ method: "update", applicationId, commandId, specName: spec.name });
    },
  };
  return { api, calls };
}

describe("registerApplicationCommands", () => {
  it("lists, then creates/updates exactly the five manifest commands", async () => {
    const { api, calls } = fakeRegistrationApi([{ id: "cmd-1", name: "start" }]);
    const result = await registerApplicationCommands(api, "app-1");
    expect(calls[0]).toEqual({ method: "list", applicationId: "app-1" });
    expect(calls.filter((c) => c.method === "update")).toHaveLength(1);
    expect(calls.filter((c) => c.method === "create").map((c) => c.specName)).toEqual(["agents", "agent", "whoami", "abort"]);
    expect(result).toEqual({ created: ["agents", "agent", "whoami", "abort"], updated: ["start"] });
  });

  it("propagates a registration failure for the caller to degrade gracefully", async () => {
    const api: DiscordApplicationCommandApi = {
      async listApplicationCommands() {
        throw new Error("Missing Access");
      },
      async createApplicationCommand() {},
      async updateApplicationCommand() {},
    };
    await expect(registerApplicationCommands(api, "app-1")).rejects.toThrow("Missing Access");
  });
});

describe("maybeRegisterApplicationCommands", () => {
  it("does nothing (no registration call) when application_id is missing or blank", async () => {
    const { api, calls } = fakeRegistrationApi([]);
    expect(await maybeRegisterApplicationCommands(api, undefined)).toBeNull();
    expect(await maybeRegisterApplicationCommands(api, "")).toBeNull();
    expect(await maybeRegisterApplicationCommands(api, "   ")).toBeNull();
    expect(calls).toEqual([]);
  });

  it("registers when application_id is present", async () => {
    const { api, calls } = fakeRegistrationApi([]);
    const result = await maybeRegisterApplicationCommands(api, "app-1");
    expect(result?.created).toEqual(["start", "agents", "agent", "whoami", "abort"]);
    expect(calls.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Interaction command parsing (fail-closed shape validation)
// ---------------------------------------------------------------------------

describe("parseInteractionCommand", () => {
  it("parses each of the five commands", () => {
    for (const name of ["start", "agents", "whoami", "abort"]) {
      const parsed = parseInteractionCommand({ type: 2, data: { name } });
      expect(parsed).toEqual({ ok: true, command: name, arg: undefined });
    }
    const agent = parseInteractionCommand({
      type: 2,
      data: { name: "agent", options: [{ name: "name", type: 3, value: "thor" }] },
    });
    expect(agent).toEqual({ ok: true, command: "agent", arg: "thor" });
  });

  it("rejects non-application-command interaction types", () => {
    expect(parseInteractionCommand({ type: 3, data: { name: "start" } }).ok).toBe(false);
    expect(parseInteractionCommand({ data: { name: "start" } }).ok).toBe(false);
  });

  it("rejects unknown command names", () => {
    expect(parseInteractionCommand({ type: 2, data: { name: "new" } }).ok).toBe(false);
    expect(parseInteractionCommand({ type: 2, data: { name: "rm" } }).ok).toBe(false);
  });

  it("rejects missing data or command name", () => {
    expect(parseInteractionCommand({ type: 2 }).ok).toBe(false);
    expect(parseInteractionCommand({ type: 2, data: {} }).ok).toBe(false);
  });

  it("rejects /agent without a non-empty string name option", () => {
    expect(parseInteractionCommand({ type: 2, data: { name: "agent" } }).ok).toBe(false);
    expect(parseInteractionCommand({ type: 2, data: { name: "agent", options: [] } }).ok).toBe(false);
    expect(parseInteractionCommand({ type: 2, data: { name: "agent", options: [{ name: "name", type: 3, value: 42 }] } }).ok).toBe(false);
    expect(parseInteractionCommand({ type: 2, data: { name: "agent", options: [{ name: "name", type: 3, value: "  " }] } }).ok).toBe(false);
  });
});
