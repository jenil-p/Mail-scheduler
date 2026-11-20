import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// GHSA-g3hv-75wg-m249: minimatch releases before 11.0.1 carry a ReDoS
// vulnerability. The dependency tree must resolve the patched version, so a
// future downgrade or re-resolution of the transitive minimatch is caught.
describe("minimatch security pin", () => {
  it("resolves minimatch to the patched 11.0.1 version", () => {
    const pkgPath = new URL(
      "../../node_modules/minimatch/package.json",
      import.meta.url,
    );
    const { version } = JSON.parse(
      readFileSync(pkgPath, "utf8"),
    ) as { version: string };
    expect(version).toBe("11.0.1");
  });
});
