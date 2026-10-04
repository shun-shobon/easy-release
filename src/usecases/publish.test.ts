import * as v from "valibot";
import { describe, expect, it, vi } from "vitest";

import { configSchema } from "../services/config";
import type { ReleaseContext, ReleaseEvent } from "../services/definitions";
import type { ReleaseService } from "../services/releases";

import type { DraftServices } from "./draft";
import { publish, publishMerged } from "./publish";

describe("publish", () => {
  it("delegates publishing to the service", async () => {
    const input = { releaseId: 9, tag: "v1.2.3", commit: "a".repeat(40) };
    const result = { ...input, releaseUrl: "https://github.com/o/r/releases/9" };
    const releases = { publish: vi.fn<ReleaseService["publish"]>().mockResolvedValue(result) };

    await expect(publish(releases, input)).resolves.toEqual(result);
    expect(releases.publish).toHaveBeenCalledWith(input);
  });
});

const config = v.parse(configSchema, { packageFiles: ["package.json"] });
const sha = "a".repeat(40);
const input = { releaseId: 9, tag: "v1.2.3", commit: sha };
const result = { ...input, releaseUrl: "https://github.com/o/r/releases/9" };
const event: Extract<ReleaseEvent, { kind: "pull-request" }> = {
  kind: "pull-request",
  action: "closed",
  merged: true,
  mergeCommit: sha,
  baseBranch: "main",
  branch: "release/prepare-v1.2.3",
  repository: "o/r",
};
const context: ReleaseContext = {
  repository: "o/r",
  defaultBranch: "main",
  sha,
  ref: "refs/heads/main",
  event,
};

function services() {
  return {
    preparation: {
      verifyMerged: vi
        .fn<DraftServices["preparation"]["verifyMerged"]>()
        .mockResolvedValue({ version: "1.2.3", tag: input.tag }),
    },
    releases: {
      ensureDraft: vi.fn<ReleaseService["ensureDraft"]>().mockResolvedValue(result),
      publish: vi.fn<ReleaseService["publish"]>().mockResolvedValue(result),
    },
  };
}

describe("publishMerged", () => {
  it.each(["v", "app/", ""])(
    "passes enabled version tag settings with prefix %s",
    async (tagPrefix) => {
      const dependencies = services();

      const tag = `${tagPrefix}1.2.3`;
      dependencies.preparation.verifyMerged.mockResolvedValue({ version: "1.2.3", tag });
      dependencies.releases.ensureDraft.mockResolvedValue({ ...result, tag });

      await publishMerged(
        { ...config, updateVersionTags: true, tagPrefix },
        { ...context, event: { ...event, branch: `${config.branchPrefix}${tag}` } },
        dependencies,
      );

      expect(dependencies.releases.publish).toHaveBeenCalledWith({
        ...input,
        tag,
        versionTags: { prefix: tagPrefix },
      });
    },
  );

  it("validates the merge and creates a release before publishing", async () => {
    const dependencies = services();

    await expect(publishMerged(config, context, dependencies)).resolves.toEqual({
      ready: true,
      version: "1.2.3",
      ...result,
    });
    expect(dependencies.preparation.verifyMerged).toHaveBeenCalledWith(config, sha, event.branch);
    expect(dependencies.releases.ensureDraft).toHaveBeenCalledWith(input.tag, sha);
    expect(dependencies.releases.publish).toHaveBeenCalledWith(input);
    expect(dependencies.preparation.verifyMerged.mock.invocationCallOrder[0]).toBeLessThan(
      dependencies.releases.ensureDraft.mock.invocationCallOrder[0] ?? 0,
    );
    expect(dependencies.releases.ensureDraft.mock.invocationCallOrder[0]).toBeLessThan(
      dependencies.releases.publish.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it.each([
    { action: "opened" },
    { merged: false },
    { baseBranch: "develop" },
    { branch: "feature/test" },
    { repository: "other/r" },
    { repository: null },
  ])("skips unrelated PRs: %j", async (change) => {
    const dependencies = services();

    await expect(
      publishMerged(
        config,
        {
          ...context,
          event: { ...event, ...change },
        },
        dependencies,
      ),
    ).resolves.toEqual({ ready: false });
    expect(dependencies.preparation.verifyMerged).not.toHaveBeenCalled();
    expect(dependencies.releases.ensureDraft).not.toHaveBeenCalled();
    expect(dependencies.releases.publish).not.toHaveBeenCalled();
  });

  it.each([{ kind: "dispatch" }, { ...event, mergeCommit: null }] satisfies ReleaseEvent[])(
    "rejects invalid publication events: %j",
    async (invalid) => {
      const dependencies = services();

      await expect(
        publishMerged(config, { ...context, event: invalid }, dependencies),
      ).rejects.toThrow();
      expect(dependencies.releases.ensureDraft).not.toHaveBeenCalled();
      expect(dependencies.releases.publish).not.toHaveBeenCalled();
    },
  );

  it("stops before creating a release when merge validation fails", async () => {
    const dependencies = services();
    dependencies.preparation.verifyMerged.mockRejectedValue(new Error("invalid version"));

    await expect(publishMerged(config, context, dependencies)).rejects.toThrow("invalid version");
    expect(dependencies.releases.ensureDraft).not.toHaveBeenCalled();
    expect(dependencies.releases.publish).not.toHaveBeenCalled();
  });

  it("stops before publishing when draft creation fails", async () => {
    const dependencies = services();
    dependencies.releases.ensureDraft.mockRejectedValue(new Error("creation failed"));

    await expect(publishMerged(config, context, dependencies)).rejects.toThrow("creation failed");
    expect(dependencies.releases.publish).not.toHaveBeenCalled();
  });

  it("propagates publication failures", async () => {
    const dependencies = services();
    dependencies.releases.publish.mockRejectedValue(new Error("publication failed"));

    await expect(publishMerged(config, context, dependencies)).rejects.toThrow(
      "publication failed",
    );
  });
});
