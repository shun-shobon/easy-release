import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PackageService } from "../services/packages";

import { FileSystemPackages } from "./package-files";

describe("package version updates", () => {
  let root: string;
  let packages: PackageService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "easy-release-versions-"));
    packages = new PackageService(new FileSystemPackages(root));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function write(relativePath: string, content: string): Promise<void> {
    const path = join(root, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }

  async function packageFile(relativePath: string, version = "1.2.3"): Promise<void> {
    await write(relativePath, JSON.stringify({ name: relativePath, version }));
  }

  it("resolves selected files without updating them", async () => {
    await packageFile("apps/main/package.json");
    await packageFile("packages/b/package.json");
    await packageFile("packages/a/package.json");

    const files = await packages.resolveFiles([
      "./apps/main/package.json",
      "packages/*/package.json",
      "packages/a/package.json",
    ]);

    expect(files).toEqual([
      "apps/main/package.json",
      "packages/a/package.json",
      "packages/b/package.json",
    ]);

    await expect(packages.verify(files, "1.2.3")).resolves.toBeUndefined();
  });

  it("expands globs again before release and rejects new packages with mismatched versions", async () => {
    await packageFile("apps/main/package.json");
    await packageFile("packages/a/package.json");
    const patterns = ["packages/*/package.json"];
    await packages.update(["apps/main/package.json", ...patterns], "1.2.4");
    await packageFile("packages/new/package.json", "1.2.3");

    const version = await packages.readVersion("apps/main/package.json");
    const files = await packages.resolveFiles(["apps/main/package.json", ...patterns]);

    await expect(packages.verify(files, version)).rejects.toThrow(
      "Package version differs from 1.2.4: packages/new/package.json (1.2.3)",
    );
    expect(await packages.readVersion("packages/new/package.json")).toBe("1.2.3");
  });

  it("updates all selected files without a root package.json", async () => {
    await packageFile("apps/main/package.json");
    await packageFile("packages/b/package.json");
    await packageFile("packages/a/package.json");

    const result = await packages.update(
      ["apps/main/package.json", "packages/*/package.json"],
      "1.3.0",
    );

    expect(result).toEqual({
      version: "1.3.0",
      files: ["apps/main/package.json", "packages/a/package.json", "packages/b/package.json"],
    });

    await expect(packages.verify(result.files, "1.3.0")).resolves.toBeUndefined();
  });

  it("updates single files and deduplicates overlapping globs", async () => {
    await packageFile("package.json");
    expect(await packages.update(["package.json"], "1.2.4")).toEqual({
      version: "1.2.4",
      files: ["package.json"],
    });
    expect(
      await packages.update(["./package.json", "package.json", "**/package.json"], "1.2.5"),
    ).toEqual({
      version: "1.2.5",
      files: ["package.json"],
    });
  });

  it("does not change an unselected root package.json", async () => {
    await packageFile("package.json", "9.0.0");
    await packageFile("packages/a/package.json");

    await packages.update(["packages/*/package.json"], "2.0.0");

    expect(await packages.readVersion("package.json")).toBe("9.0.0");
    expect(await packages.readVersion("packages/a/package.json")).toBe("2.0.0");
  });

  it("updates nothing when any glob has no matches", async () => {
    await packageFile("package.json");

    await expect(
      packages.update(["package.json", "package.json", "missing/*/package.json"], "1.2.4"),
    ).rejects.toThrow(/missing\/\*\/package.json/);
    expect(await packages.readVersion("package.json")).toBe("1.2.3");
  });

  it("excludes node_modules and .git at every depth", async () => {
    await packageFile("package.json");

    for (const path of [
      "node_modules/a/package.json",
      "nested/node_modules/a/package.json",
      ".git/package.json",
      "nested/.git/package.json",
    ]) {
      await write(path, "invalid JSON");
    }

    await packageFile("nested/package.json");
    const result = await packages.update(["package.json", "**/package.json"], "1.2.4");
    expect(result.files).toEqual(["nested/package.json", "package.json"]);
  });

  it.each([
    "!packages/*/package.json",
    "packages/!(a)/package.json",
    "../package.json",
    "packages/../package.json",
    "/tmp/package.json",
    "C:/package.json",
    "",
    "packages\\a\\package.json",
  ])("updates nothing for disallowed glob %j", async (pattern) => {
    await packageFile("package.json");

    await expect(packages.update(["package.json", pattern], "1.2.4")).rejects.toThrow();
    expect(await packages.readVersion("package.json")).toBe("1.2.3");
  });

  it("updates different initial versions to the requested shared version", async () => {
    await packageFile("package.json");
    await packageFile("packages/a/package.json");
    await packageFile("packages/z/package.json", "2.0.0");

    const result = await packages.update(["package.json", "packages/*/package.json"], "3.0.0");

    await expect(packages.verify(result.files, "3.0.0")).resolves.toBeUndefined();
  });

  it.each([
    "{",
    "[]",
    "null",
    '{"name":"private-root"}',
    '{"version":123}',
    '{"version":"1.2.3-beta"}',
  ])("rejects invalid package.json %j before writing", async (content) => {
    await packageFile("package.json");
    await write("packages/bad/package.json", content);

    await expect(
      packages.update(["package.json", "packages/*/package.json"], "1.2.4"),
    ).rejects.toThrow(/packages\/bad\/package.json/);
    expect(await packages.readVersion("package.json")).toBe("1.2.3");
  });

  it("preserves other properties, tabs, CRLF, and the trailing newline", async () => {
    const original =
      '{\r\n\t"name": "test",\r\n\t"version": "1.2.3",\r\n\t"private": true,\r\n\t"dependencies": {\r\n\t\t"other": "workspace:*"\r\n\t}\r\n}\r\n';
    await write("package.json", original);
    await packages.update(["package.json"], "1.2.4");
    expect(await readFile(join(root, "package.json"), "utf8")).toBe(
      original.replace('"1.2.3"', '"1.2.4"'),
    );
  });

  it("preserves four-space indentation and the absence of a trailing newline", async () => {
    const original = JSON.stringify({ name: "test", version: "1.2.3" }, null, 4);
    await write("package.json", original);
    await packages.update(["package.json"], "1.2.4");
    expect(await readFile(join(root, "package.json"), "utf8")).toBe(
      original.replace('"1.2.3"', '"1.2.4"'),
    );
  });

  it("rejects paths outside the repository and excluded directories", async () => {
    await packageFile("package.json");
    await packageFile("node_modules/a/package.json");

    await expect(packages.readVersion("../package.json")).rejects.toThrow();
    await expect(packages.readVersion(join(root, "package.json"))).rejects.toThrow();
    await expect(packages.readVersion("node_modules/a/package.json")).rejects.toThrow();
  });

  it("rejects symlinked package.json files", async () => {
    await packageFile("original/package.json");
    await symlink(join(root, "original/package.json"), join(root, "package.json"));

    await expect(packages.readVersion("package.json")).rejects.toThrow(/symbolic/i);
  });

  it("rejects files under symlinked directories", async () => {
    await packageFile("original/package.json");
    await symlink(join(root, "original"), join(root, "linked"), "dir");

    await expect(
      packages.update(["original/package.json", "linked/package.json"], "1.2.4"),
    ).rejects.toThrow(/symbolic/i);
    expect(await packages.readVersion("original/package.json")).toBe("1.2.3");
  });

  it("rejects links outside the repository without changing their targets", async () => {
    const repository = join(root, "repository");
    await packageFile("repository/package.json");
    await packageFile("outside/package.json");
    await symlink(join(root, "outside"), join(repository, "linked"), "dir");

    await expect(
      new PackageService(new FileSystemPackages(repository)).update(
        ["package.json", "linked/package.json"],
        "1.2.4",
      ),
    ).rejects.toThrow(/symbolic/i);
    expect(await packages.readVersion("outside/package.json")).toBe("1.2.3");
    expect(
      await new PackageService(new FileSystemPackages(repository)).readVersion("package.json"),
    ).toBe("1.2.3");
  });

  it("rejects globs that match directories", async () => {
    await packageFile("package.json");
    await mkdir(join(root, "packages/empty/package.json"), { recursive: true });

    await expect(
      packages.update(["package.json", "packages/*/package.json"], "1.2.4"),
    ).rejects.toThrow(/file/i);
  });

  it("detects versions changed, deleted, or replaced with links by later commands", async () => {
    await packageFile("package.json");

    await expect(packages.verify(["package.json"], "1.2.4")).rejects.toThrow(/version/i);
    await rm(join(root, "package.json"));

    await expect(packages.verify(["package.json"], "1.2.3")).rejects.toThrow();
    await packageFile("original/package.json");
    await symlink(join(root, "original/package.json"), join(root, "package.json"));

    await expect(packages.verify(["package.json"], "1.2.3")).rejects.toThrow(/symbolic/i);
  });
});
