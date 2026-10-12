import type { PackageFileStore } from "./definitions";
import { packageFormat } from "./package-formats";

export class PackageService {
  constructor(private readonly store: PackageFileStore) {}

  private async readPackage(file: string) {
    const source = await this.store.read(file);
    const format = packageFormat(file);

    try {
      return { file, source, format, versions: format.versions(source) };
    } catch (cause) {
      throw new Error(`Invalid package file: ${file}`, { cause });
    }
  }

  resolveFiles(packageFiles: string[]): Promise<string[]> {
    return this.store.resolve(packageFiles);
  }

  async update(packageFiles: string[], version: string): Promise<string[]> {
    const files = await this.store.resolve(packageFiles);
    const packages = await Promise.all(files.map((file) => this.readPackage(file)));
    const contents = packages.map((pkg) => {
      try {
        return { file: pkg.file, content: pkg.format.update(pkg.source, version) };
      } catch (cause) {
        throw new Error(`Cannot update package version: ${pkg.file}`, { cause });
      }
    });

    for (const { file, content } of contents) {
      await this.store.write(file, content);
    }

    return files;
  }

  async verify(files: string[], version: string): Promise<void> {
    for (const file of files) {
      for (const actual of (await this.readPackage(file)).versions) {
        if (actual !== version) {
          throw new Error(`Package version differs from ${version}: ${file} (${actual})`);
        }
      }
    }
  }
}
