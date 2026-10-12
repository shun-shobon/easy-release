import { isStableVersion } from "../utils/version";

import type { Config } from "./config";

type NamingConfig = Pick<Config, "branchPrefix" | "tagPrefix">;

export function releaseNames(config: NamingConfig, version: string) {
  const tag = config.tagPrefix + version;

  return { tag, branch: config.branchPrefix + tag };
}

export function parseManagedBranch(config: NamingConfig, branch: string): string | undefined {
  const prefix = config.branchPrefix + config.tagPrefix;

  if (!branch.startsWith(prefix)) {
    return undefined;
  }

  const version = branch.slice(prefix.length);

  return isStableVersion(version) ? version : undefined;
}

export function preparationMessage(tag: string): string {
  return `chore: bump version to ${tag}\n\nUpdate the selected files to a shared version for release.`;
}
