import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const logoPath = join(process.cwd(), "web", "src", "assets", "piren-logo.png");

describe("web workbench brand assets (ADR-0041 R3b-1)", () => {
  it("ships the transparent Piren logo as a PNG in the Vite source assets", async () => {
    const logo = await readFile(logoPath);
    // PNG magic bytes: \x89 P N G
    expect(logo.subarray(0, 4).toString("hex")).toBe("89504e47");
  });

  it("imports the logo in the workbench shell and references it in the README", async () => {
    const app = await readFile(join(process.cwd(), "web", "src", "App.tsx"), "utf8");
    expect(app).toContain('from "./assets/piren-logo.png"');

    const readme = await readFile(join(process.cwd(), "README.md"), "utf8");
    expect(readme).toContain("web/src/assets/piren-logo.png");
  });
});
