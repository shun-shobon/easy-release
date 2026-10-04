import { describe, expect, it, vi } from "vitest";

import type { ReleaseRepository } from "./definitions";
import { ReleaseService } from "./releases";

const sha = "a".repeat(40);
const release = {
  id: 9,
  tag: "v1.2.3",
  commit: sha,
  draft: true,
  url: "https://github.com/o/r/releases/9",
};

function repository() {
  return {
    listTags: vi.fn<ReleaseRepository["listTags"]>(),
    getBranch: vi.fn<ReleaseRepository["getBranch"]>(),
    getTag: vi.fn<ReleaseRepository["getTag"]>(),
    getAnnotatedTag: vi.fn<ReleaseRepository["getAnnotatedTag"]>(),
    getCommitMessage: vi.fn<ReleaseRepository["getCommitMessage"]>(),
    createCommit: vi.fn<ReleaseRepository["createCommit"]>(),
    listOpenPullRequests: vi.fn<ReleaseRepository["listOpenPullRequests"]>(),
    closePullRequest: vi.fn<ReleaseRepository["closePullRequest"]>(),
    deleteBranch: vi.fn<ReleaseRepository["deleteBranch"]>(),
    createBranch: vi.fn<ReleaseRepository["createBranch"]>(),
    createPullRequest: vi.fn<ReleaseRepository["createPullRequest"]>(),
    listReleases: vi.fn<ReleaseRepository["listReleases"]>(),
    getRelease: vi.fn<ReleaseRepository["getRelease"]>(),
    createTag: vi.fn<ReleaseRepository["createTag"]>(),
    createDraft: vi.fn<ReleaseRepository["createDraft"]>(),
    listAssets: vi.fn<ReleaseRepository["listAssets"]>(),
    publishRelease: vi.fn<ReleaseRepository["publishRelease"]>(),
  };
}

describe("ReleaseService", () => {
  it("validates the tag and assets before publishing", async () => {
    const repo = repository();
    repo.getRelease.mockResolvedValue(release);
    repo.getTag.mockResolvedValue({ type: "commit", sha });
    repo.listAssets.mockResolvedValue([{ name: "app.zip", state: "uploaded" }]);
    repo.publishRelease.mockResolvedValue({ ...release, draft: false });

    await expect(
      new ReleaseService(repo).publish({ releaseId: 9, tag: release.tag, commit: sha }),
    ).resolves.toMatchObject({ releaseId: 9 });
    expect(repo.listAssets.mock.invocationCallOrder[0]).toBeLessThan(
      repo.publishRelease.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("does not publish with incomplete assets", async () => {
    const repo = repository();
    repo.getRelease.mockResolvedValue(release);
    repo.getTag.mockResolvedValue({ type: "commit", sha });
    repo.listAssets.mockResolvedValue([{ name: "app.zip", state: "starter" }]);

    await expect(
      new ReleaseService(repo).publish({ releaseId: 9, tag: release.tag, commit: sha }),
    ).rejects.toThrow("uploads");
    expect(repo.publishRelease).not.toHaveBeenCalled();
  });

  it("resolves nested tags and reuses the existing draft", async () => {
    const repo = repository();
    repo.listReleases.mockResolvedValue([release]);
    repo.getTag.mockResolvedValue({ type: "tag", sha: "b".repeat(40) });
    repo.getAnnotatedTag.mockResolvedValue({ type: "commit", sha });

    await expect(new ReleaseService(repo).ensureDraft(release.tag, sha)).resolves.toMatchObject({
      releaseId: 9,
    });
    expect(repo.createTag).not.toHaveBeenCalled();
    expect(repo.createDraft).not.toHaveBeenCalled();
  });
});
