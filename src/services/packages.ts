import * as v from "valibot";

import { assertStableVersion } from "../utils/version";

import type { PackageFileStore } from "./definitions";

const packageSchema = v.record(v.string(), v.unknown());

function serializePackage(source: string, data: Record<string, unknown>): string {
  const indentation = /^[\t ]+(?=")/mu.exec(source)?.[0];
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const trailingWhitespace = source.slice(source.trimEnd().length);
  const serialized = JSON.stringify(data, null, indentation);

  return serialized.replaceAll("\n", newline) + trailingWhitespace;
}

export class PackageService {
  constructor(private readonly store: PackageFileStore) {}

  private async readPackage(file: string) {
    const source = await this.store.read(file);

    try {
      const value: unknown = JSON.parse(source);
      const data = v.parse(packageSchema, value);
      const version = v.parse(v.string(), data["version"]);
      assertStableVersion(version);

      return { file, source, data, version };
    } catch (cause) {
      throw new Error(`Invalid package version or JSON: ${file}`, { cause });
    }
  }

  async readVersion(file: string): Promise<string> {
    return (await this.readPackage(file)).version;
  }

  resolveFiles(packageFiles: string[]): Promise<string[]> {
    return this.store.resolve(packageFiles);
  }

  async update(packageFiles: string[], version: string) {
    assertStableVersion(version);
    const files = await this.store.resolve(packageFiles);
    const packages = await Promise.all(files.map((file) => this.readPackage(file)));

    for (const pkg of packages) {
      pkg.data["version"] = version;
      await this.store.write(pkg.file, serializePackage(pkg.source, pkg.data));
    }

    return { version, files };
  }

  async verify(files: string[], version: string): Promise<void> {
    assertStableVersion(version);

    for (const file of files) {
      const actual = await this.readVersion(file);

      if (actual !== version) {
        throw new Error(`Package version differs from ${version}: ${file} (${actual})`);
      }
    }
  }
}
