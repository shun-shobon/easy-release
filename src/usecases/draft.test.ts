import * as v from "valibot";
import { describe, expect, it, vi } from "vitest";

import { configSchema } from "../services/config";
import type { ReleaseContext } from "../services/definitions";

import { draft, type DraftServices } from "./draft";

const config = v.parse(configSchema, {
  packageFiles: ["package.json"],
});
const sha = "a".repeat(40);
const updated = {
  previousVersion: "1.2.2",
  version: "1.2.3",
  files: ["package.json"],
  tag: "v1.2.3",
  branch: "release/prepare-v1.2.3",
};
const result = {
  tag: updated.tag,
  commit: sha,
  releaseId: 9,
  releaseUrl: "https://github.com/o/r/releases/9",
};

function services() {
  return {
    preparation: {
      verifyMerged: vi
        .fn<DraftServices["preparation"]["verifyMerged"]>()
        .mockResolvedValue({ version: updated.version, tag: updated.tag }),
    },
    releases: {
      ensureDraft: vi.fn<DraftServices["releases"]["ensureDraft"]>().mockResolvedValue(result),
    },
  };
}

function merged(): ReleaseContext {
  return {
    repository: "o/r",
    defaultBranch: "main",
    sha,
    ref: "refs/heads/main",
    event: {
      kind: "pull-request",
      action: "closed",
      merged: true,
      mergeCommit: sha,
      baseBranch: "main",
      branch: updated.branch,
      repository: "o/r",
    },
  };
}

describe("draft", () => {
  it("does not create a draft for merges outside the default branch", async () => {
    const dependencies = services();

    await expect(
      draft(config, { ...merged(), defaultBranch: "develop" }, dependencies),
    ).resolves.toEqual({ ready: false });
    expect(dependencies.preparation.verifyMerged).not.toHaveBeenCalled();
  });

  it("skips unrelated PRs without calling services", async () => {
    const dependencies = services();
    const event = merged();

    if (event.event.kind !== "pull-request") {
      throw new Error("Expected pull request");
    }

    event.event.branch = "feature/test";

    await expect(draft(config, event, dependencies)).resolves.toEqual({ ready: false });
    expect(dependencies.preparation.verifyMerged).not.toHaveBeenCalled();
    expect(dependencies.releases.ensureDraft).not.toHaveBeenCalled();
  });

  it.each(["main", "develop"])(
    "creates a draft after validating the merge into %s",
    async (defaultBranch) => {
      const dependencies = services();
      const context = merged();
      context.defaultBranch = defaultBranch;

      if (context.event.kind !== "pull-request") {
        throw new Error("Expected pull request");
      }

      context.event.baseBranch = defaultBranch;

      await expect(draft(config, context, dependencies)).resolves.toMatchObject({
        ready: true,
        version: "1.2.3",
        releaseId: 9,
      });
      expect(dependencies.preparation.verifyMerged).toHaveBeenCalledWith(
        config,
        sha,
        updated.branch,
      );
      expect(dependencies.releases.ensureDraft).toHaveBeenCalledWith(updated.tag, sha);
    },
  );

  it("does not create a draft when merge validation fails", async () => {
    const dependencies = services();
    dependencies.preparation.verifyMerged.mockRejectedValue(new Error("invalid version"));

    await expect(draft(config, merged(), dependencies)).rejects.toThrow("invalid version");
    expect(dependencies.releases.ensureDraft).not.toHaveBeenCalled();
  });
});
