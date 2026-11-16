import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// GHSA-5j98-mcp5-4vw2: glob releases before 10.5.0 carry a command-injection
// vulnerability in the CLI. The dependency tree must resolve the patched
// version, so a future downgrade or re-resolution of the transitive glob is
// caught.
describe("glob security pin", () => {
  it("resolves glob to the patched 10.5.0 version", () => {
    const pkgPath = new URL(
      "../../node_modules/glob/package.json",
      import.meta.url,
    );
    const { version } = JSON.parse(
      readFileSync(pkgPath, "utf8"),
    ) as { version: string };
    expect(version).toBe("10.5.0");
  });
});
