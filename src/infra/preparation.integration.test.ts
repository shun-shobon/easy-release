import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import * as v from "valibot";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { configSchema } from "../services/config";
import { PackageService } from "../services/packages";
import { PreparationService } from "../services/preparation";
import type { ReleaseType } from "../utils/version";

import { FileSystemPackages } from "./package-files";
import { createWorkspace } from "./workspace";

const execute = promisify(execFile);
const config = v.parse(configSchema, { packageFiles: ["package.json"] });

describe("preparation with a Git checkout", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "easy-release-preparation-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function git(...args: string[]) {
    const { stdout } = await execute("git", args, { cwd: root, timeout: 10_000 });

    return stdout.trim();
  }

  async function fixture(version: string) {
    await git("init", "--quiet");
    await writeFile(join(root, "package.json"), JSON.stringify({ version }, null, 2) + "\n");
    await git("add", "--all");
    const tree = await git("write-tree");
    const commit = await git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit-tree",
      tree,
      "-m",
      "fixture",
    );
    await git("update-ref", "HEAD", commit);

    return new PreparationService(
      createWorkspace(root),
      new PackageService(new FileSystemPackages(root)),
    );
  }

  it.each([
    { type: "patch", version: "0.0.1" },
    { type: "minor", version: "0.1.0" },
    { type: "major", version: "1.0.0" },
  ] satisfies Array<{ type: ReleaseType; version: string }>)(
    "prepares the first $type release from version 0.0.0",
    async ({ type, version }) => {
      const preparation = await fixture("0.0.0");

      const updated = await preparation.updateVersions(config, "0.0.0", type);
      const changes = await preparation.finish(config, updated);

      expect(updated.tag).toBe(`v${version}`);
      expect(changes).toEqual([
        {
          path: "package.json",
          mode: "100644",
          content: Buffer.from(JSON.stringify({ version }, null, 2) + "\n"),
        },
      ]);
    },
  );

  it("accepts a first release whose package already has the target version", async () => {
    const preparation = await fixture("0.1.0");
    const updated = await preparation.updateVersions(config, "0.0.0", "minor");

    await expect(preparation.finish(config, updated)).resolves.toEqual([]);
  });

  it("accepts preparation without packages or an update command", async () => {
    const preparation = await fixture("0.1.0");
    const emptyConfig = { ...config, packageFiles: [] };

    const updated = await preparation.updateVersions(emptyConfig, "0.0.0", "minor");

    await expect(preparation.finish(emptyConfig, updated)).resolves.toEqual([]);
  });
});
