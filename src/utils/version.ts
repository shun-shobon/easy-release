import { gt, inc, parse } from "semver";

export type ReleaseType = "major" | "minor" | "patch";

export function isStableVersion(version: string): boolean {
  const parsed = parse(version);

  return (
    parsed !== null &&
    parsed.version === version &&
    parsed.prerelease.length === 0 &&
    parsed.build.length === 0
  );
}

export function assertStableVersion(version: string): void {
  if (!isStableVersion(version)) {
    throw new Error(`Invalid version; expected X.Y.Z with safe integers: ${version}`);
  }
}

export function bumpVersion(current: string, type: ReleaseType): string {
  assertStableVersion(current);
  const next = inc(current, type);

  if (next === null) {
    throw new Error(`Cannot increment version: ${current}`);
  }

  assertStableVersion(next);

  return next;
}

export function latestVersion(tags: string[], prefix: string): string {
  let latest = "0.0.0";

  for (const tag of tags) {
    if (!tag.startsWith(prefix)) {
      continue;
    }

    const version = tag.slice(prefix.length);

    if (isStableVersion(version) && gt(version, latest)) {
      latest = version;
    }
  }

  return latest;
}
