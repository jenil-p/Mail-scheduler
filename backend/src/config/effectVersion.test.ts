import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guard against the ReDoS in `Schema.TemplateLiteral` (GHSA-7589-6fvf-x4pw),
 * fixed in effect@3.22.1. `effect` is pulled in transitively by
 * @prisma/config, so the resolved version is pinned through the lockfile.
 */
const FIXED_EFFECT_VERSION = "3.22.1";

type LockfilePackage = {
  version?: string;
};

type Lockfile = {
  packages?: Record<string, LockfilePackage>;
};

function readLockfile(): Lockfile {
  const lockfilePath = fileURLToPath(
    new URL("../../package-lock.json", import.meta.url),
  );
  return JSON.parse(readFileSync(lockfilePath, "utf8")) as Lockfile;
}

function compareVersions(left: string, right: string): number {
  const parse = (version: string) =>
    version.split("-")[0].split(".").map((part) => Number(part));
  const leftParts = parse(left);
  const rightParts = parse(right);

  for (let i = 0; i < Math.max(leftParts.length, rightParts.length); i += 1) {
    const diff = (leftParts[i] ?? 0) - (rightParts[i] ?? 0);
    if (diff !== 0) return diff;
  }

  return 0;
}

describe("effect dependency", () => {
  it("resolves effect to the version that fixes GHSA-7589-6fvf-x4pw", () => {
    const lockfile = readLockfile();
    const resolved = lockfile.packages?.["node_modules/effect"];

    expect(resolved?.version).toBeDefined();
    expect(
      compareVersions(resolved?.version ?? "0.0.0", FIXED_EFFECT_VERSION),
    ).toBeGreaterThanOrEqual(0);
  });

  it("keeps every installed effect entry on the fixed version", () => {
    const lockfile = readLockfile();
    const effectEntries = Object.entries(lockfile.packages ?? {}).filter(
      ([path]) =>
        path === "node_modules/effect" ||
        path.endsWith("/node_modules/effect"),
    );

    expect(effectEntries.length).toBeGreaterThan(0);
    for (const [path, pkg] of effectEntries) {
      expect(
        compareVersions(pkg.version ?? "0.0.0", FIXED_EFFECT_VERSION),
        `${path} resolves effect@${pkg.version ?? "unknown"}`,
      ).toBeGreaterThanOrEqual(0);
    }
  });
});
