import { assertStableVersion, bumpVersion, type ReleaseType } from "../utils/version";

import type { Config } from "./config";
import type { Workspace } from "./definitions";
import type { PackageService } from "./packages";

export type VersionUpdate = {
  previousVersion: string;
  version: string;
  files: string[];
  tag: string;
  branch: string;
};

export class PreparationService {
  constructor(
    private readonly workspace: Workspace,
    private readonly packages: PackageService,
  ) {}

  assertCheckout(commit: string): Promise<void> {
    return this.workspace.assertCheckout(commit);
  }

  async updateVersions(
    config: Config,
    previousVersion: string,
    type: ReleaseType,
  ): Promise<VersionUpdate> {
    const version = bumpVersion(previousVersion, type);
    const tag = config.tagPrefix + version;
    const branch = config.branchPrefix + tag;

    await this.workspace.validateRefs([`refs/tags/${tag}`, `refs/heads/${branch}`]);

    const updated = await this.packages.update(config.packageFiles, version);

    return { ...updated, previousVersion, tag, branch };
  }

  async finish(config: Config, updated: VersionUpdate) {
    if (config.updateCommand) {
      await this.workspace.runUpdateCommand(
        config.updateCommand,
        updated.previousVersion,
        updated.version,
      );
    }

    await this.packages.verify(updated.files, updated.version);
    const changes = await this.workspace.collectChanges();

    if (changes.length === 0) {
      throw new Error("No changes to prepare for release.");
    }

    return changes;
  }

  async verifyMerged(config: Config, commit: string, branch: string) {
    await this.workspace.assertCheckout(commit);
    const prefix = config.branchPrefix + config.tagPrefix;

    if (!branch.startsWith(prefix)) {
      throw new Error("Not a release preparation branch.");
    }

    const version = branch.slice(prefix.length);
    assertStableVersion(version);
    const tag = config.tagPrefix + version;
    const files = await this.packages.resolveFiles(config.packageFiles);
    await this.packages.verify(files, version);

    await this.workspace.validateRefs([`refs/tags/${tag}`, `refs/heads/${branch}`]);

    return { version, tag };
  }
}
