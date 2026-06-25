import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const publicDir = join(process.cwd(), "public");

describe("public brand assets", () => {
  it("ships light and dark Piren SVG logos for browsers and README renderers", async () => {
    const darkPath = join(publicDir, "piren-logo-dark.svg");
    const lightPath = join(publicDir, "piren-logo-light.svg");

    await expect(stat(darkPath)).resolves.toMatchObject({ isFile: expect.any(Function) });
    await expect(stat(lightPath)).resolves.toMatchObject({ isFile: expect.any(Function) });

    const dark = await readFile(darkPath, "utf8");
    const light = await readFile(lightPath, "utf8");

    expect(dark).toContain("<title>Piren logo - dark</title>");
    expect(light).toContain("<title>Piren logo - light</title>");
    expect(dark).toContain("@media (prefers-reduced-motion: reduce)");
    expect(light).toContain("@media (prefers-reduced-motion: reduce)");
    expect(dark).not.toContain("<script");
    expect(light).not.toContain("<script");
  });

  it("uses the Piren logo in the gateway shell and README", async () => {
    const index = await readFile(join(publicDir, "index.html"), "utf8");
    const readme = await readFile(join(process.cwd(), "README.md"), "utf8");

    expect(index).toContain("/piren-logo-dark.svg");
    expect(index).toContain("Piren animated logo");
    expect(readme).toContain("public/piren-logo-light.svg");
    expect(readme).toContain("public/piren-logo-dark.svg");
  });
});
