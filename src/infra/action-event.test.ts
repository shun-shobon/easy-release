import { describe, expect, it } from "vitest";

import { parseDefaultBranch, parseReleaseEvent } from "./action-event";

describe("default branch parsing", () => {
  it.each(["main", "master", "develop", "release/stable"])("uses %s from the event", (branch) => {
    expect(parseDefaultBranch({ repository: { default_branch: branch } })).toBe(branch);
  });

  it.each([
    {},
    { repository: {} },
    { repository: { default_branch: "" } },
    { repository: { default_branch: null } },
  ])("rejects an invalid default branch: %j", (event) => {
    expect(() => parseDefaultBranch(event)).toThrow();
  });
});

describe("merge commit input", () => {
  function event(commit: unknown) {
    return {
      action: "closed",
      pull_request: {
        merged: commit !== null,
        merge_commit_sha: commit,
        base: { ref: "main" },
        head: { ref: "release/prepare-v1.2.3", repo: { full_name: "o/r" } },
      },
    };
  }

  it.each(["commit-id", "a".repeat(40), null])(
    "accepts nonempty strings and null for unmerged PRs: %j",
    (commit) => {
      expect(parseReleaseEvent("pull_request", event(commit))).toMatchObject({
        mergeCommit: commit,
      });
    },
  );

  it.each(["", 123, undefined])("rejects empty strings and non-string values: %j", (commit) => {
    expect(() => parseReleaseEvent("pull_request", event(commit))).toThrow();
  });
});
