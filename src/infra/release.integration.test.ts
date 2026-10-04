import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as v from "valibot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GitHub } from "../infra/github";
import { assertCheckout, collectChanges, runUpdateCommand, validateRefs } from "../infra/workspace";
import { configSchema, type Config } from "../services/config";
import { PackageService } from "../services/packages";
import { PreparationService } from "../services/preparation";
import { ReleaseService } from "../services/releases";
import { draft as executeDraft } from "../usecases/draft";
import { prepare as executePrepare } from "../usecases/prepare";
import { publish as executePublish } from "../usecases/publish";
import type { ReleaseType } from "../utils/version";

import { parseReleaseEvent } from "./action-event";
import { FileSystemPackages } from "./package-files";

vi.mock("../infra/workspace", () => ({
  assertCheckout: vi.fn(),
  collectChanges: vi.fn(),
  runUpdateCommand: vi.fn(),
  validateRefs: vi.fn(),
}));

type FixtureContext = {
  root: string;
  repository: string;
  defaultBranch: string;
  eventName: string;
  event: unknown;
  sha: string;
  ref: string;
};

function services(root: string, github: GitHub) {
  return {
    releases: new ReleaseService(github),
    preparation: new PreparationService(
      {
        assertCheckout: (sha) => assertCheckout(root, sha),
        validateRefs: (refs) => validateRefs(root, refs),
        runUpdateCommand: (command, previous, version) =>
          runUpdateCommand(root, command, previous, version),
        collectChanges: () => collectChanges(root),
      },
      new PackageService(new FileSystemPackages(root)),
    ),
  };
}

function prepare(config: Config, context: FixtureContext, github: GitHub, type: ReleaseType) {
  return executePrepare(
    config,
    { ...context, event: parseReleaseEvent(context.eventName, context.event) },
    services(context.root, github),
    type,
  );
}

async function draft(config: Config, context: FixtureContext, github: GitHub) {
  return executeDraft(
    config,
    { ...context, event: parseReleaseEvent(context.eventName, context.event) },
    services(context.root, github),
  );
}

function publish(github: GitHub, input: { releaseId: number; tag: string; commit: string }) {
  return executePublish(new ReleaseService(github), input);
}

const sha = "a".repeat(40);
const config = v.parse(configSchema, {
  packageFiles: ["package.json"],
});

const release = {
  id: 9,
  tag_name: "v1.2.3",
  target_commitish: sha,
  draft: true,
  html_url: "https://github.com/o/r/releases/9",
};

function client(responses: unknown[], tags: string[] = ["v1.2.3"]) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({
      method: init?.method ?? "GET",
      path: decodeURIComponent(input instanceof Request ? input.url : input.toString()),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });

    if (calls.at(-1)?.path === "https://api.github.com/repos/o/r/tags?per_page=100") {
      return Response.json(tags.map((name) => ({ name })));
    }

    const value = responses.shift();
    if (value === undefined) {
      throw new Error("Unexpected request");
    }

    return value instanceof Response ? value : Response.json(value);
  };

  return { github: new GitHub("https://api.github.com", "o/r", "test", fetcher), calls };
}

describe("config", () => {
  it("requires explicit package targets", () => {
    expect(() => v.parse(configSchema, {})).toThrow();
    expect(config).toMatchObject({
      tagPrefix: "v",
      branchPrefix: "release/prepare-",
    });
  });

  it.each([
    { commands: "typo" },
    { packageFiles: [1] },
    { branchPrefix: "" },
    { updateCommand: "" },
  ])("rejects invalid configuration: %j", (invalid) => {
    expect(() => v.parse(configSchema, { ...config, ...invalid })).toThrow();
  });

  it("accepts an empty tag prefix", () => {
    expect(v.parse(configSchema, { ...config, tagPrefix: "" })).toMatchObject({ tagPrefix: "" });
  });
});

describe("draft eligibility", () => {
  it("ignores unrelated PRs before accessing the filesystem or API", async () => {
    const { github, calls } = client([]);

    await expect(
      draft(
        config,
        {
          root: "/missing",
          repository: "o/r",
          defaultBranch: "main",
          eventName: "pull_request",
          sha,
          ref: "refs/heads/main",
          event: {
            action: "closed",
            pull_request: {
              merged: true,
              merge_commit_sha: sha,
              base: { ref: "main" },
              head: { ref: "feature/x", repo: { full_name: "o/r" } },
            },
          },
        },
        github,
      ),
    ).resolves.toEqual({ ready: false });
    expect(calls).toHaveLength(0);
  });

  it("rejects malformed GitHub events", async () => {
    const { github } = client([]);

    await expect(
      draft(
        config,
        {
          root: "/missing",
          repository: "o/r",
          defaultBranch: "main",
          eventName: "pull_request",
          sha,
          ref: "refs/heads/main",
          event: {},
        },
        github,
      ),
    ).rejects.toThrow();
  });
});

describe("publish", () => {
  it("publishes only after checking the release, tag commit, and uploaded assets", async () => {
    const { github, calls } = client([
      release,
      { object: { type: "commit", sha } },
      [{ state: "uploaded", name: "app.zip" }],
      { ...release, draft: false },
    ]);

    await expect(
      publish(github, { releaseId: 9, tag: "v1.2.3", commit: sha }),
    ).resolves.toMatchObject({ releaseId: 9 });
    expect(calls.at(-1)).toMatchObject({
      method: "PATCH",
      body: { draft: false, make_latest: "true" },
    });
  });

  it.each([
    [{ ...release, draft: false }, "already published"],
    [{ ...release, tag_name: "v2.0.0" }, "tag"],
  ])("rejects an incompatible release", async (value, message) => {
    const { github, calls } = client([value]);

    await expect(publish(github, { releaseId: 9, tag: "v1.2.3", commit: sha })).rejects.toThrow(
      String(message),
    );
    expect(calls).toHaveLength(1);
  });

  it("does not publish when the tag points to a different commit", async () => {
    const { github, calls } = client([
      release,
      { object: { type: "commit", sha: "b".repeat(40) } },
    ]);

    await expect(publish(github, { releaseId: 9, tag: "v1.2.3", commit: sha })).rejects.toThrow(
      "commit",
    );
    expect(calls).toHaveLength(2);
  });

  it("does not publish incomplete assets", async () => {
    const { github, calls } = client([
      release,
      { object: { type: "commit", sha } },
      [{ state: "starter", name: "app.zip" }],
    ]);

    await expect(publish(github, { releaseId: 9, tag: "v1.2.3", commit: sha })).rejects.toThrow(
      "uploads",
    );
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("propagates upload list failures without publishing", async () => {
    const { github, calls } = client([
      release,
      { object: { type: "commit", sha } },
      new Response("unavailable", { status: 503 }),
    ]);

    await expect(publish(github, { releaseId: 9, tag: "v1.2.3", commit: sha })).rejects.toThrow();
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });
});

describe("prepare and draft lifecycle", () => {
  let root: string;

  beforeEach(async () => {
    vi.resetAllMocks();
    root = await mkdtemp(join(tmpdir(), "easy-release-service-"));
    await writeFile(join(root, "package.json"), '{"version":"1.2.3"}\n');
    vi.mocked(collectChanges).mockResolvedValue([
      { path: "package.json", mode: "100644", content: Buffer.from('{"version":"1.2.4"}\n') },
    ]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function context() {
    return {
      root,
      repository: "o/r",
      defaultBranch: "main",
      eventName: "workflow_dispatch",
      sha,
      ref: "refs/heads/main",
      event: {},
    };
  }

  function merged() {
    return {
      ...context(),
      eventName: "pull_request",
      event: {
        action: "closed",
        pull_request: {
          merged: true,
          merge_commit_sha: sha,
          base: { ref: "main" },
          head: { ref: "release/prepare-v1.2.3", repo: { full_name: "o/r" } },
        },
      },
    };
  }

  const reference = { object: { type: "commit", sha } };
  const missing = () => new Response("", { status: 404 });

  it("creates a draft on the merge commit with generated release notes", async () => {
    const { github, calls } = client([[], missing(), reference, release]);

    await expect(draft(config, merged(), github)).resolves.toMatchObject({
      ready: true,
      releaseId: 9,
      tag: "v1.2.3",
      commit: sha,
    });
    expect(assertCheckout).toHaveBeenCalledWith(root, sha);
    expect(calls.at(-1)?.body).toEqual({
      tag_name: "v1.2.3",
      target_commitish: sha,
      name: "v1.2.3",
      draft: true,
      generate_release_notes: true,
    });
  });

  it("reuses a draft for the same commit without changing its notes", async () => {
    const { github, calls } = client([[release], reference]);

    await expect(draft(config, merged(), github)).resolves.toMatchObject({
      ready: true,
      releaseId: 9,
    });
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("rejects a published release before creating a tag", async () => {
    const { github, calls } = client([[{ ...release, draft: false }]]);

    await expect(draft(config, merged(), github)).rejects.toThrow("already published");
    expect(calls).toHaveLength(1);
  });

  it("rejects a tag at another commit without altering it", async () => {
    const { github, calls } = client([[], { object: { type: "commit", sha: "b".repeat(40) } }]);

    await expect(draft(config, merged(), github)).rejects.toThrow("commit");
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("rejects a mismatching branch version", async () => {
    await writeFile(join(root, "package.json"), '{"version":"9.0.0"}');
    const { github, calls } = client([]);

    await expect(draft(config, merged(), github)).rejects.toThrow("version");
    expect(calls).toHaveLength(0);
  });

  it.each(["main", "develop"])(
    "creates a preparation PR for default branch %s and replaces only managed PRs",
    async (defaultBranch) => {
      const pulls = [
        { number: 1, head: { ref: "release/prepare-v1.2.4", repo: { full_name: "o/r" } } },
        { number: 2, head: { ref: "feature/next", repo: { full_name: "o/r" } } },
        { number: 3, head: { ref: "release/prepare-v1.2.4", repo: { full_name: "other/r" } } },
      ];
      const { github, calls } = client([
        reference,
        missing(),
        pulls,
        reference,
        { tree: { sha } },
        { sha },
        { sha },
        { sha },
        { state: "closed" },
        reference,
        new Response(null, { status: 204 }),
        reference,
        { number: 10, html_url: "https://github.com/o/r/pull/10" },
      ]);

      await expect(
        prepare(
          config,
          { ...context(), defaultBranch, ref: `refs/heads/${defaultBranch}` },
          github,
          "patch",
        ),
      ).resolves.toMatchObject({
        version: "1.2.4",
        pullRequestNumber: 10,
      });

      expect(calls[0]?.path).toBe(
        `https://api.github.com/repos/o/r/git/ref/heads/${defaultBranch}`,
      );
      expect(calls.find((call) => call.path.includes("/pulls?"))?.path).toContain(
        `base=${defaultBranch}`,
      );
      expect(calls.at(-1)?.body).toMatchObject({ base: defaultBranch });

      const mutationPaths = calls
        .filter((call) => call.method === "PATCH" || call.method === "DELETE")
        .map((call) => call.path);
      expect(mutationPaths).toEqual([
        "https://api.github.com/repos/o/r/pulls/1",
        "https://api.github.com/repos/o/r/git/refs/heads/release/prepare-v1.2.4",
      ]);
      expect(calls.findIndex((call) => call.path.endsWith("/git/commits"))).toBeLessThan(
        calls.findIndex((call) => call.method === "PATCH"),
      );
    },
  );

  it.each([
    {
      tags: ["v1.9.0", "v1.10.0", "v8.0.0-beta.1"],
      type: "patch",
      previous: "1.10.0",
      version: "1.10.1",
    },
    { tags: [], type: "patch", previous: "0.0.0", version: "0.0.1" },
    { tags: [], type: "minor", previous: "0.0.0", version: "0.1.0" },
    { tags: [], type: "major", previous: "0.0.0", version: "1.0.0" },
  ] satisfies Array<{ tags: string[]; type: ReleaseType; previous: string; version: string }>)(
    "updates to $version based on tags rather than file versions",
    async ({ tags, type, previous, version }) => {
      await writeFile(join(root, "package.json"), '{"version":"9.9.9"}');
      const { github, calls } = client(
        [
          reference,
          missing(),
          [],
          missing(),
          { tree: { sha } },
          { sha },
          { sha },
          { sha },
          reference,
          { number: 10, html_url: "https://github.com/o/r/pull/10" },
        ],
        tags,
      );

      await expect(
        prepare({ ...config, updateCommand: "update-other-files" }, context(), github, type),
      ).resolves.toMatchObject({ version, tag: `v${version}` });

      expect(JSON.parse(await readFile(join(root, "package.json"), "utf8"))).toMatchObject({
        version,
      });
      expect(runUpdateCommand).toHaveBeenCalledWith(root, "update-other-files", previous, version);
      expect(calls.at(-1)?.body).toMatchObject({ head: `release/prepare-v${version}` });
    },
  );

  it("prepares a release using an update command without packages", async () => {
    await rm(join(root, "package.json"));
    vi.mocked(runUpdateCommand).mockImplementation(async (_root, _command, _previous, version) => {
      await writeFile(join(root, "VERSION"), version);
    });
    vi.mocked(collectChanges).mockResolvedValue([
      { path: "VERSION", mode: "100644", content: Buffer.from("0.0.1") },
    ]);
    const { github } = client(
      [
        reference,
        missing(),
        [],
        missing(),
        { tree: { sha } },
        { sha },
        { sha },
        { sha },
        reference,
        { number: 10, html_url: "https://github.com/o/r/pull/10" },
      ],
      [],
    );

    await expect(
      prepare(
        { ...config, packageFiles: [], updateCommand: "update-version" },
        context(),
        github,
        "patch",
      ),
    ).resolves.toMatchObject({ version: "0.0.1" });
    expect(await readFile(join(root, "VERSION"), "utf8")).toBe("0.0.1");
  });

  it("uses the preparation branch version for drafts without packages", async () => {
    await rm(join(root, "package.json"));
    const { github } = client([[], missing(), reference, release]);

    await expect(draft({ ...config, packageFiles: [] }, merged(), github)).resolves.toMatchObject({
      version: "1.2.3",
    });
  });

  it("fails before closing PRs when the hook fails", async () => {
    vi.mocked(runUpdateCommand).mockRejectedValue(new Error("hook failed"));
    const { github, calls } = client([reference, missing()]);

    await expect(
      prepare({ ...config, updateCommand: "node update.mjs" }, context(), github, "patch"),
    ).rejects.toThrow("hook failed");
    expect(runUpdateCommand).toHaveBeenCalledWith(root, "node update.mjs", "1.2.3", "1.2.4");
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("checks that a successful hook did not undo the version update", async () => {
    vi.mocked(runUpdateCommand).mockImplementation(async () => {
      await writeFile(join(root, "package.json"), '{"version":"1.2.3"}');
    });

    const { github, calls } = client([reference, missing()]);

    await expect(
      prepare({ ...config, updateCommand: "node update.mjs" }, context(), github, "patch"),
    ).rejects.toThrow();
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("rejects a stale base before editing files", async () => {
    const { github, calls } = client([{ object: { type: "commit", sha: "b".repeat(40) } }]);

    await expect(prepare(config, context(), github, "patch")).rejects.toThrow("base branch");
    expect(calls).toHaveLength(1);
  });

  it("rejects invalid refs before any remote mutation", async () => {
    vi.mocked(validateRefs).mockRejectedValue(new Error("invalid ref"));
    const { github, calls } = client([reference]);

    await expect(
      prepare({ ...config, tagPrefix: "invalid tag " }, context(), github, "patch"),
    ).rejects.toThrow("invalid ref");
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("rejects a child package mismatch before draft or tag creation", async () => {
    await writeFile(join(root, "child.json"), '{"version":"1.2.2"}');
    const { github, calls } = client([]);

    await expect(
      draft({ ...config, packageFiles: ["child.json"] }, merged(), github),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("recreates an orphaned preparation branch after PR creation failed", async () => {
    const first = client([
      reference,
      missing(),
      [],
      missing(),
      { tree: { sha } },
      { sha },
      { sha },
      { sha },
      reference,
      new Response("", { status: 503 }),
    ]);

    await expect(prepare(config, context(), first.github, "patch")).rejects.toThrow();
    const generatedCommit = first.calls.find(
      (call) => call.path.endsWith("/git/commits") && call.method === "POST",
    );
    if (!generatedCommit) {
      throw new Error("No preparation commit");
    }

    await writeFile(join(root, "package.json"), '{"version":"1.2.3"}');
    const retry = client([
      reference,
      missing(),
      [],
      reference,
      generatedCommit.body,
      { tree: { sha } },
      { sha },
      { sha },
      { sha },
      new Response(null, { status: 204 }),
      reference,
      { number: 10, html_url: "https://github.com/o/r/pull/10" },
    ]);

    await expect(prepare(config, context(), retry.github, "patch")).resolves.toMatchObject({
      pullRequestNumber: 10,
    });
    expect(retry.calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
  });

  it("does not delete an unrelated orphan branch", async () => {
    const { github, calls } = client([
      reference,
      missing(),
      [],
      reference,
      { message: "unrelated work" },
    ]);

    await expect(prepare(config, context(), github, "patch")).rejects.toThrow(
      "does not belong to a preparation PR",
    );
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });
});
