# Extension recipes

Piren core is minimal. Additional capability comes from Pi extension packages (ADR-0013): npm packages that export Pi extensions, declared in `~/.config/piren/config.yml` under the `packages` field. Piren resolves each declared package to its installed entry point and appends it as an additional `--extension` flag to the Pi command.

This page is a cookbook for declaring, writing, and testing extensions.

## Declare a package

In `~/.config/piren/config.yml`:

```yaml
vault_root: /path/to/vault
allowed_agents:
  - piren
packages:
  - "@your-org/piren-github-tools"
  - "piren-cardano-extension"
```

Piren's core extension loads first, then package extensions load in declaration order. `piren doctor` checks that every declared package is installed and reports any missing ones.

## How Piren resolves packages

Piren calls Node's `require.resolve` on each declared package name to find its main entry point (defined by the package's `main` or `exports` field in its `package.json`). The resolved path becomes the `--extension` argument passed to Pi.

A package that cannot be resolved is recorded as missing, not fatal. This lets `piren doctor` report all missing packages in one pass. See `src/packages.ts` for the pure resolution logic.

## Write a minimal extension

A Pi extension is a module that registers tools and commands with the Pi runtime. The Piren extension (`src/pi-extension.ts`) is the reference. A minimal package extension follows the same shape:

```typescript
// my-piren-extension/index.ts
import type { PiExtensionApi } from "pi-coding-agent";

export default function extension(pi: PiExtensionApi) {
  pi.registerTool({
    name: "my_tool",
    description: "Does something useful.",
    parameters: { /* JSON schema */ },
    execute: async (id, args) => {
      // Tool logic here.
      return {
        content: [{ type: "text", text: "Done." }],
      };
    },
  });

  pi.registerCommand("my_command", {
    description: "A slash command.",
    execute: async (args) => {
      // Command logic here.
    },
  });
}
```

The exact `PiExtensionApi` shape comes from the Pi Coding Agent SDK. Match the patterns in `src/pi-extension.ts` for parameter validation, error handling, and content-block formatting.

## When to use a package vs a vault skill

| Need | Use |
|------|-----|
| Reusable procedure (how to do TDD, how to write an ADR) | Vault skill |
| Code that must run (call an API, parse a file, transform data) | Pi package extension |
| Project-specific convention | Vault skill or project doc |
| New tool the agent can call | Pi package extension |
| New slash command | Pi package extension |

Skills are Markdown procedures injected into agent context. Packages are code that registers tools and commands with the runtime. If the capability is procedural guidance, it is a skill. If the capability is executable logic, it is a package.

## Recipe: minimal coding workstation

```yaml
packages:
  - "@your-org/piren-github-tools"
  - "piren-test-helpers"
```

Use when the steward wants a lean coding assistant. Piren core vault tools plus GitHub integration and test/build helpers.

## Recipe: homelab operator

```yaml
packages:
  - "piren-service-lifecycle-tools"
  - "piren-ssh-inspection"
```

Use when the steward wants an agent for edge devices. Piren core vault tools plus service lifecycle and SSH inspection. Pair with vault-backed cron for routine checks.

## Recipe: research and wiki agent

```yaml
packages:
  - "piren-web-extraction"
  - "piren-arxiv-extension"
```

Use when the steward wants a low-overhead knowledge curator. Piren core vault tools plus web extraction and arXiv search, writing results into the OKF wiki.

## Testing extensions

Extensions should be testable without live Pi auth. Follow the pattern in `tests/pi-extension.test.ts`: use the fake Pi harness and fake filesystem to exercise tool registration and execution in isolation. Core logic should live in pure modules callable directly from tests, with the extension file doing only adaptation.

Run the smoke test to verify the full extension surface loads:

```bash
npm run smoke
```

## Related

- ADR-0013 — Pi package extensibility
- [Skills](skills.md)
- [Configuration](configuration.md)
- [Operations](operations.md)
