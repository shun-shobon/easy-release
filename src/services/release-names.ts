import { isStableVersion } from "../utils/version";

import type { Config } from "./config";

export function managedBranch(
  config: Pick<Config, "branchPrefix" | "tagPrefix">,
  branch: string,
): boolean {
  const prefix = config.branchPrefix + config.tagPrefix;

  return branch.startsWith(prefix) && isStableVersion(branch.slice(prefix.length));
}

export function preparationMessage(tag: string): string {
  return `chore: bump version to ${tag}\n\nUpdate the selected files to a shared version for release.`;
}
