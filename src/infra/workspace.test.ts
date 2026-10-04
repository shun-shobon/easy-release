import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { assertCheckout, collectChanges, runUpdateCommand, validateRefs } from "./workspace";

const execute = promisify(execFile);
const directories: string[] = [];

async function git(root: string, ...args: string[]): Promise<string> {
  const { stdout } = await execute("git", args, {
    cwd: root,
    timeout: 10_000,
    maxBuffer: 1_048_576,
  });

  return stdout.trim();
}

async function commit(root: string): Promise<string> {
  await git(root, "add", "--all");
  const tree = await git(root, "write-tree");
  const sha = await git(
    root,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit-tree",
    tree,
    "-m",
    "fixture",
  );
  await git(root, "update-ref", "HEAD", sha);

  return sha;
}

async function fixture(): Promise<{ root: string; sha: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "easy release-")));
  directories.push(root);
  await git(root, "init", "--quiet");
  await writeFile(join(root, ".gitignore"), "ignored.txt\n");
  await writeFile(join(root, "file.txt"), "before\n");

  return { root, sha: await commit(root) };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("assertCheckout", () => {
  it("accepts the clean repository at the requested commit", async () => {
    const { root, sha } = await fixture();

    await expect(assertCheckout(root, sha)).resolves.toBeUndefined();
  });

  it("rejects another HEAD", async () => {
    const { root } = await fixture();

    await expect(assertCheckout(root, "0".repeat(40))).rejects.toThrow(/HEAD/);
  });

  it("rejects a subdirectory of the checkout", async () => {
    const { root, sha } = await fixture();
    const nested = join(root, "nested");
    await mkdir(nested);

    await expect(assertCheckout(nested, sha)).rejects.toThrow(/root/);
  });

  it.each(["tracked", "untracked", "staged"])("rejects %s changes", async (kind) => {
    const { root, sha } = await fixture();
    await writeFile(join(root, kind === "untracked" ? "new.txt" : "file.txt"), "changed");
    if (kind === "staged") {
      await git(root, "add", "--all");
    }

    await expect(assertCheckout(root, sha)).rejects.toThrow(/clean/);
  });
});

describe("runUpdateCommand", () => {
  it("passes both versions and runs in the checkout", async () => {
    const { root } = await fixture();
    await runUpdateCommand(
      root,
      'printf "%s:%s" "$PREVIOUS_VERSION" "$RELEASE_VERSION" > versions.txt',
      "1.2.3",
      "2.0.0",
    );
    expect(await readFile(join(root, "versions.txt"), "utf8")).toBe("1.2.3:2.0.0");
  });

  it.each(["exit 7", "false; touch should-not-exist", "false | true"])(
    "rejects a failed command: %s",
    async (command) => {
      const { root } = await fixture();

      await expect(runUpdateCommand(root, command, "1.0.0", "1.0.1")).rejects.toThrow();
      await expect(readFile(join(root, "should-not-exist"))).rejects.toThrow();
    },
  );

  it("stops descendants from writing files after command failure", async () => {
    const { root } = await fixture();

    await expect(
      runUpdateCommand(
        root,
        "bash -c 'sleep 0.3; printf leaked > leaked.txt' & exit 7",
        "1.0.0",
        "1.0.1",
      ),
    ).rejects.toThrow();
    await setTimeout(450);

    await expect(readFile(join(root, "leaked.txt"))).rejects.toThrow();
  });

  it("reports process startup errors", async () => {
    const { root } = await fixture();

    await expect(runUpdateCommand(join(root, "missing"), "true", "1.0.0", "1.0.1")).rejects.toThrow(
      /ENOENT/,
    );
  });
});

describe("validateRefs", () => {
  it("accepts branch and namespaced tag references", async () => {
    const { root } = await fixture();

    await expect(
      validateRefs(root, ["refs/heads/release/prepare-v1.0.0", "refs/tags/project/v1.0.0"]),
    ).resolves.toBeUndefined();
  });

  it.each([
    "refs/heads/bad name",
    "refs/tags/version..1",
    "refs/heads/trailing/",
    "refs/tags/bad.lock",
    "--allow-onelevel",
  ])("rejects an invalid ref: %s", async (ref) => {
    const { root } = await fixture();

    await expect(validateRefs(root, [ref])).rejects.toThrow();
  });
});

describe("collectChanges", () => {
  it("stages changes and preserves paths, bytes, deletions, symlinks and executable modes", async () => {
    const { root } = await fixture();
    const binary = Buffer.from([0, 255, 128, 10]);
    await writeFile(join(root, "file.txt"), "after\n");
    await writeFile(join(root, "binary space.bin"), binary);
    await writeFile(join(root, "tab\tnewline\n.txt"), "unusual path");
    await writeFile(join(root, "run.sh"), "#!/bin/sh\n");
    await chmod(join(root, "run.sh"), 0o755);
    await symlink("file.txt", join(root, "link"));
    await writeFile(join(root, "ignored.txt"), "ignored");
    await rm(join(root, ".gitignore"));
    // Keep the ignore rule local while deleting the tracked file.
    await writeFile(join(root, ".git", "info", "exclude"), "ignored.txt\n");
    const changes = await collectChanges(root);
    expect(changes).toEqual([
      { path: ".gitignore", mode: "100644", content: null },
      { path: "binary space.bin", mode: "100644", content: binary },
      { path: "file.txt", mode: "100644", content: Buffer.from("after\n") },
      { path: "link", mode: "120000", content: Buffer.from("file.txt") },
      { path: "run.sh", mode: "100755", content: Buffer.from("#!/bin/sh\n") },
      { path: "tab\tnewline\n.txt", mode: "100644", content: Buffer.from("unusual path") },
    ]);
  });

  it("returns no changes for a clean checkout", async () => {
    const { root } = await fixture();
    expect(await collectChanges(root)).toEqual([]);
  });

  it("rejects a changed submodule", async () => {
    const { root, sha } = await fixture();
    await git(root, "clone", "--quiet", root, "module");
    await git(root, "update-index", "--add", "--cacheinfo", `160000,${sha},module`);

    await expect(collectChanges(root)).rejects.toThrow(/mode|submodule/);
  });

  it.each(["delete", "replace"])("rejects a submodule %s", async (operation) => {
    const { root, sha } = await fixture();
    await git(root, "clone", "--quiet", root, "module");
    await git(root, "update-index", "--add", "--cacheinfo", `160000,${sha},module`);
    await commit(root);
    await rm(join(root, "module"), { recursive: true });
    if (operation === "replace") {
      await writeFile(join(root, "module"), "regular file");
    }

    await expect(collectChanges(root)).rejects.toThrow(/mode|submodule/);
  });
});
