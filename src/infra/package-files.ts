import { glob, lstat, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, posix, resolve, sep, win32 } from "node:path";

import type { PackageFileStore } from "../services/definitions";

function validateRelativePath(path: string): void {
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    win32.isAbsolute(path) ||
    path.includes("\\") ||
    /(^|[/,{])\.\.($|[/,}])/u.test(path)
  ) {
    throw new Error(`Expected a repository-relative path without parent traversal: ${path}`);
  }
}

function isExcluded(path: string): boolean {
  return path.split(/[\\/]/u).some((part) => part === "node_modules" || part === ".git");
}

async function packagePath(root: string, file: string): Promise<string> {
  validateRelativePath(file);
  if (isExcluded(file)) {
    throw new Error(`Package path is excluded: ${file}`);
  }

  let path = resolve(root);
  const segments = posix.normalize(file).split("/");

  for (const [index, segment] of segments.entries()) {
    path = join(path, segment);
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      throw new Error(`Symbolic links are not allowed in package paths: ${file}`);
    }

    if (index === segments.length - 1 && !info.isFile()) {
      throw new Error(`Package path must be a file: ${file}`);
    }
  }

  return path;
}

export class FileSystemPackages implements PackageFileStore {
  constructor(private readonly root: string) {}

  async read(file: string): Promise<string> {
    return readFile(await packagePath(this.root, file), "utf8");
  }

  async write(file: string, content: string): Promise<void> {
    await writeFile(await packagePath(this.root, file), content);
  }

  async resolve(packageFiles: string[]): Promise<string[]> {
    const selected = new Set<string>();

    for (const pattern of packageFiles) {
      validateRelativePath(pattern);
      if (pattern.startsWith("!") || pattern.includes("!(")) {
        throw new Error(`Only positive package globs are supported: ${pattern}`);
      }

      let matched = false;

      for await (const match of glob(pattern, { cwd: this.root, exclude: isExcluded })) {
        const file = match.split(sep).join("/");
        if (!isExcluded(file)) {
          validateRelativePath(file);
          selected.add(posix.normalize(file));
          matched = true;
        }
      }

      if (!matched) {
        throw new Error(`Package glob matched no files: ${pattern}`);
      }
    }

    return [...selected].sort();
  }
}
