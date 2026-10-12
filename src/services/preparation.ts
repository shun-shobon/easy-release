import { bumpVersion, type ReleaseType } from "../utils/version";

import type { Config } from "./config";
import type { FileChange, Workspace } from "./definitions";
import type { PackageService } from "./packages";
import { releaseNames } from "./release-names";

export type PreparationPlan = {
  previousVersion: string;
  version: string;
  tag: string;
  branch: string;
};

export class PreparationService {
  constructor(
    private readonly workspace: Workspace,
    private readonly packages: PackageService,
  ) {}

  async plan(
    config: Config,
    commit: string,
    previousVersion: string,
    type: ReleaseType,
  ): Promise<PreparationPlan> {
    await this.workspace.assertCheckout(commit);

    const version = bumpVersion(previousVersion, type);
    const { tag, branch } = releaseNames(config, version);
    await this.workspace.validateRefs([`refs/tags/${tag}`, `refs/heads/${branch}`]);

    return { previousVersion, version, tag, branch };
  }

  async apply(config: Config, plan: PreparationPlan): Promise<FileChange[]> {
    const files = await this.packages.update(config.packageFiles, plan.version);

    if (config.updateCommand) {
      await this.workspace.runUpdateCommand(
        config.updateCommand,
        plan.previousVersion,
        plan.version,
      );
    }

    await this.packages.verify(files, plan.version);

    return this.workspace.collectChanges();
  }

  async verifyMerged(config: Config, commit: string, version: string): Promise<void> {
    await this.workspace.assertCheckout(commit);

    const files = await this.packages.resolveFiles(config.packageFiles);
    await this.packages.verify(files, version);
  }
}
