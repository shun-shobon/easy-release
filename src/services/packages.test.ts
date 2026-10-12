import { describe, expect, it, vi } from "vitest";

import type { PackageFileStore } from "./definitions";
import { PackageService } from "./packages";

function store(contents: Record<string, string>) {
  return {
    resolve: vi.fn<PackageFileStore["resolve"]>().mockResolvedValue(Object.keys(contents)),
    read: vi.fn<PackageFileStore["read"]>().mockImplementation(async (file) => {
      const content = contents[file];

      if (content === undefined) {
        throw new Error(`Missing file: ${file}`);
      }

      return content;
    }),
    write: vi.fn<PackageFileStore["write"]>().mockImplementation(async (file, content) => {
      contents[file] = content;
    }),
  };
}

describe("PackageService", () => {
  it("updates multiple packages to the same version through the storage interface", async () => {
    const files = store({ "a.json": '{"version":"1.2.3"}', "b.json": '{"version":"1.2.3"}' });
    const service = new PackageService(files);

    await expect(service.update(["a.json", "b.json"], "1.3.0")).resolves.toEqual([
      "a.json",
      "b.json",
    ]);
    expect(files.write).toHaveBeenCalledWith("a.json", '{"version":"1.3.0"}');
    expect(files.write).toHaveBeenCalledWith("b.json", '{"version":"1.3.0"}');
  });

  it("updates files with different initial versions to the requested version", async () => {
    const files = store({ "a.json": '{"version":"1.2.3"}', "b.json": '{"version":"2.0.0"}' });

    await new PackageService(files).update(["*.json"], "3.0.1");

    expect(files.write).toHaveBeenCalledWith("a.json", '{"version":"3.0.1"}');
    expect(files.write).toHaveBeenCalledWith("b.json", '{"version":"3.0.1"}');
  });

  it("rejects invalid files before writing", async () => {
    const files = store({ "a.json": '{"version":"1.2.3"}', "b.json": '{"version":null}' });

    await expect(new PackageService(files).update(["*.json"], "3.0.1")).rejects.toThrow("b.json");
    expect(files.write).not.toHaveBeenCalled();
  });

  it("updates and verifies JSON and Cargo packages together", async () => {
    const files = store({
      "package.json": '{"version":"1.2.3"}',
      "crates/app/Cargo.toml": '[package]\nversion = "1.2.3"\n',
      "crates/lib/Cargo.toml": "[package]\nversion.workspace = true\n",
    });
    const service = new PackageService(files);

    const updated = await service.update(["**"], "1.3.0");

    expect(files.write).toHaveBeenCalledWith("package.json", '{"version":"1.3.0"}');
    expect(files.write).toHaveBeenCalledWith(
      "crates/app/Cargo.toml",
      '[package]\nversion = "1.3.0"\n',
    );
    expect(files.write).toHaveBeenCalledWith(
      "crates/lib/Cargo.toml",
      "[package]\nversion.workspace = true\n",
    );
    await expect(service.verify(updated, "1.3.0")).resolves.toBeUndefined();
    await expect(service.verify(["crates/app/Cargo.toml"], "1.3.1")).rejects.toThrow(
      "crates/app/Cargo.toml (1.3.0)",
    );
  });

  it("does not write any file when a Cargo package is invalid", async () => {
    const files = store({
      "package.json": '{"version":"1.2.3"}',
      "Cargo.toml": '[package]\nversion = "1.2.3"\nversion = "1.2.3"\n',
    });

    await expect(new PackageService(files).update(["**"], "1.3.0")).rejects.toThrow("Cargo.toml");
    expect(files.write).not.toHaveBeenCalled();
  });

  it("propagates storage read errors without writing", async () => {
    const files = store({ "a.json": '{"version":"1.2.3"}' });
    files.read.mockRejectedValue(new Error("read failed"));

    await expect(new PackageService(files).update(["a.json"], "1.2.4")).rejects.toThrow(
      "read failed",
    );
    expect(files.write).not.toHaveBeenCalled();
  });

  it("propagates storage write errors", async () => {
    const files = store({ "a.json": '{"version":"1.2.3"}' });
    files.write.mockRejectedValue(new Error("write failed"));

    await expect(new PackageService(files).update(["a.json"], "1.2.4")).rejects.toThrow(
      "write failed",
    );
  });
});
