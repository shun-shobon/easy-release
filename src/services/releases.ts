import { latestVersion } from "../utils/version";

import type { Config } from "./config";
import type { FileChange, Release, ReleaseRepository } from "./definitions";
import { managedBranch, preparationMessage } from "./release-names";

export type PublishInput = { releaseId: number; tag: string; commit: string };
export type PreparationInput = {
  config: Config;
  repository: string;
  baseBranch: string;
  baseCommit: string;
  version: string;
  tag: string;
  branch: string;
  changes: FileChange[];
};

function result(release: Release, tag: string, commit: string) {
  return { releaseId: release.id, releaseUrl: release.url, tag, commit };
}

export class ReleaseService {
  constructor(private readonly repository: ReleaseRepository) {}

  async currentVersion(tagPrefix: string): Promise<string> {
    return latestVersion(await this.repository.listTags(), tagPrefix);
  }

  private async tagCommit(tag: string): Promise<string | undefined> {
    let reference = await this.repository.getTag(tag);

    while (reference?.type === "tag") {
      reference = await this.repository.getAnnotatedTag(reference.sha);
    }

    return reference?.sha;
  }

  async assertBaseCommit(branch: string, commit: string): Promise<void> {
    const reference = await this.repository.getBranch(branch);

    if (reference?.type !== "commit" || reference.sha !== commit) {
      throw new Error("The base branch has changed. Run preparation again.");
    }
  }

  async assertTagAvailable(tag: string): Promise<void> {
    if (await this.tagCommit(tag)) {
      throw new Error(`Tag ${tag} already exists.`);
    }
  }

  async createPreparation(input: PreparationInput) {
    const { config, tag, branch } = input;
    const pulls = await this.repository.listOpenPullRequests(input.baseBranch);
    const previous = pulls.filter(
      (pull) => pull.repository === input.repository && managedBranch(config, pull.branch),
    );
    const existing = await this.repository.getBranch(branch);
    const orphaned = existing && !previous.some((pull) => pull.branch === branch);

    if (orphaned) {
      const message = await this.repository.getCommitMessage(existing.sha);

      if (message !== preparationMessage(tag)) {
        throw new Error(`Branch ${branch} already exists and does not belong to a preparation PR.`);
      }
    }

    const commit = await this.repository.createCommit({
      parent: input.baseCommit,
      message: preparationMessage(tag),
      changes: input.changes,
    });

    // Save the new changes before replacing previous preparation PRs.
    for (const pull of previous) {
      await this.repository.closePullRequest(pull.number);

      if (await this.repository.getBranch(pull.branch)) {
        await this.repository.deleteBranch(pull.branch);
      }
    }

    if (orphaned) {
      await this.repository.deleteBranch(branch);
    }

    await this.repository.createBranch(branch, commit);
    const pull = await this.repository.createPullRequest({
      base: input.baseBranch,
      branch,
      title: `chore: prepare release ${tag}`,
      body: `Update the selected files to version ${input.version}.\n\nMerging this PR creates a draft release. The release is published after the build and asset upload succeed.`,
    });

    return {
      version: input.version,
      tag,
      commit,
      pullRequestNumber: pull.number,
      pullRequestUrl: pull.url,
    };
  }

  async ensureDraft(tag: string, commit: string) {
    const releases = await this.repository.listReleases();
    const existing = releases.find((release) => release.tag === tag);

    if (existing && !existing.draft) {
      throw new Error(`${tag} is already published.`);
    }

    if (existing && existing.commit !== commit) {
      throw new Error("The draft release targets a different commit.");
    }

    const tagged = await this.tagCommit(tag);

    if (tagged && tagged !== commit) {
      throw new Error("The tag does not point to the merge commit.");
    }

    if (!tagged) {
      await this.repository.createTag(tag, commit);
    }

    const release = existing ?? (await this.repository.createDraft(tag, commit));

    if (!release.draft || release.tag !== tag || release.commit !== commit) {
      throw new Error("The created release does not match the expected draft, tag, or commit.");
    }

    return result(release, tag, commit);
  }

  async publish(input: PublishInput) {
    const release = await this.repository.getRelease(input.releaseId);

    if (!release.draft) {
      throw new Error("This release is already published.");
    }

    if (release.tag !== input.tag) {
      throw new Error("The release tag does not match.");
    }

    if (release.commit !== input.commit || (await this.tagCommit(input.tag)) !== input.commit) {
      throw new Error("The release commit does not match.");
    }

    const assets = await this.repository.listAssets(input.releaseId);

    if (assets.some((asset) => asset.state !== "uploaded")) {
      throw new Error("Asset uploads are incomplete.");
    }

    const published = await this.repository.publishRelease(input.releaseId);

    if (published.draft || published.tag !== input.tag || published.id !== input.releaseId) {
      throw new Error("The published release does not match the expected state, tag, or ID.");
    }

    return result(published, input.tag, input.commit);
  }
}
