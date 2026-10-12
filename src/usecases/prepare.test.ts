import * as v from "valibot";
import { describe, expect, it, vi } from "vitest";

import { configSchema } from "../services/config";
import type { ReleaseContext } from "../services/definitions";

import { prepare, type PrepareServices } from "./prepare";

const config = v.parse(configSchema, {
  packageFiles: ["package.json"],
});
const sha = "a".repeat(40);
const plan = {
  previousVersion: "1.2.2",
  version: "1.2.3",
  tag: "v1.2.3",
  branch: "release/prepare-v1.2.3",
};
function services() {
  return {
    preparation: {
      plan: vi.fn<PrepareServices["preparation"]["plan"]>().mockResolvedValue(plan),
      apply: vi.fn<PrepareServices["preparation"]["apply"]>().mockResolvedValue([]),
    },
    releases: {
      currentVersion: vi
        .fn<PrepareServices["releases"]["currentVersion"]>()
        .mockResolvedValue("1.2.2"),
      assertBaseCommit: vi.fn<PrepareServices["releases"]["assertBaseCommit"]>(),
      assertTagAvailable: vi.fn<PrepareServices["releases"]["assertTagAvailable"]>(),
      createPreparation: vi.fn<PrepareServices["releases"]["createPreparation"]>(),
    },
  };
}

function context(): ReleaseContext {
  return {
    repository: "o/r",
    defaultBranch: "main",
    sha,
    ref: "refs/heads/main",
    event: { kind: "dispatch" },
  };
}

describe("prepare", () => {
  it("checks base, tags, and the plan before updating files and requesting a PR", async () => {
    const dependencies = services();
    const { preparation, releases } = dependencies;

    await prepare(config, context(), dependencies, "patch");

    const order = [
      releases.assertBaseCommit,
      releases.currentVersion,
      preparation.plan,
      releases.assertTagAvailable,
      preparation.apply,
      releases.createPreparation,
    ].map((method) => method.mock.invocationCallOrder[0]);
    expect(order).toEqual([...order].sort((left, right) => Number(left) - Number(right)));
    expect(releases.currentVersion).toHaveBeenCalledWith(config.tagPrefix);
    expect(preparation.plan).toHaveBeenCalledWith(config, sha, "1.2.2", "patch");
    expect(preparation.apply).toHaveBeenCalledWith(config, plan);
    expect(releases.createPreparation).toHaveBeenCalledWith(
      expect.objectContaining({ baseCommit: sha, tag: plan.tag, changes: [] }),
    );
  });

  it("targets the default branch when it is not main", async () => {
    const dependencies = services();

    await prepare(
      config,
      { ...context(), defaultBranch: "develop", ref: "refs/heads/develop" },
      dependencies,
      "patch",
    );

    expect(dependencies.releases.assertBaseCommit).toHaveBeenCalledWith("develop", sha);
    expect(dependencies.releases.createPreparation).toHaveBeenCalledWith(
      expect.objectContaining({ baseBranch: "develop" }),
    );
  });

  it("rejects preparation outside the default branch", async () => {
    const dependencies = services();

    await expect(
      prepare(config, { ...context(), defaultBranch: "develop" }, dependencies, "patch"),
    ).rejects.toThrow("develop");
    expect(dependencies.releases.assertBaseCommit).not.toHaveBeenCalled();
  });

  it("does not update files when base validation fails", async () => {
    const dependencies = services();
    dependencies.releases.assertBaseCommit.mockRejectedValue(new Error("stale base"));

    await expect(prepare(config, context(), dependencies, "patch")).rejects.toThrow("stale base");
    expect(dependencies.preparation.apply).not.toHaveBeenCalled();
  });

  it("does not change packages or PRs when fetching tags fails", async () => {
    const dependencies = services();
    dependencies.releases.currentVersion.mockRejectedValue(new Error("tags unavailable"));

    await expect(prepare(config, context(), dependencies, "patch")).rejects.toThrow(
      "tags unavailable",
    );
    expect(dependencies.preparation.apply).not.toHaveBeenCalled();
    expect(dependencies.releases.createPreparation).not.toHaveBeenCalled();
  });

  it("does not update files when the tag already exists", async () => {
    const dependencies = services();
    dependencies.releases.assertTagAvailable.mockRejectedValue(new Error("tag exists"));

    await expect(prepare(config, context(), dependencies, "patch")).rejects.toThrow("tag exists");
    expect(dependencies.preparation.apply).not.toHaveBeenCalled();
  });

  it("does not change PRs when update validation fails", async () => {
    const dependencies = services();
    dependencies.preparation.apply.mockRejectedValue(new Error("invalid files"));

    await expect(prepare(config, context(), dependencies, "patch")).rejects.toThrow(
      "invalid files",
    );
    expect(dependencies.releases.createPreparation).not.toHaveBeenCalled();
  });
});
