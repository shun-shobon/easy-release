import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { publish, setFailed, setOutput } = vi.hoisted(() => ({
  publish: vi.fn(),
  setFailed: vi.fn(),
  setOutput: vi.fn(),
}));

vi.mock("@actions/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@actions/core")>()),
  setFailed,
  setOutput,
  setSecret: vi.fn(),
  info: vi.fn(),
}));

vi.mock("./services/releases", () => ({
  ReleaseService: class {
    publish = publish;
  },
}));

let root: string;

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  publish.mockResolvedValue({ releaseId: 9 });
  vi.stubEnv("INPUT_MODE", "publish");
  vi.stubEnv("INPUT_TOKEN", "test-token");
  vi.stubEnv("INPUT_RELEASE-ID", "9");
  vi.stubEnv("INPUT_TAG", "v1.2.3");
  vi.stubEnv("INPUT_COMMIT", "commit");
  vi.stubEnv("GITHUB_API_URL", "https://api.github.com");
  vi.stubEnv("GITHUB_REPOSITORY", "o/r");
  root = await mkdtemp(join(tmpdir(), "easy-release-config-"));
  vi.stubEnv("GITHUB_WORKSPACE", root);
  vi.stubEnv("INPUT_CONFIG", "release.json");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("publish configuration", () => {
  it.each([
    { config: {}, expected: undefined },
    { config: { updateVersionTags: false }, expected: undefined },
    { config: { updateVersionTags: true }, expected: { prefix: "v" } },
    { config: { updateVersionTags: true, tagPrefix: "app/" }, expected: { prefix: "app/" } },
    { config: { updateVersionTags: true, tagPrefix: "" }, expected: { prefix: "" } },
  ])(
    "reads version tag settings from the configuration file: $config",
    async ({ config, expected }) => {
      await writeFile(join(root, "release.json"), JSON.stringify({ packageFiles: [], ...config }));

      await import("./index");
      await vi.waitFor(() => expect(setOutput).toHaveBeenCalledWith("release-id", 9));

      expect(publish).toHaveBeenCalledWith({
        releaseId: 9,
        tag: "v1.2.3",
        commit: "commit",
        versionTags: expected,
      });
      expect(setFailed).not.toHaveBeenCalled();
    },
  );

  it.each(["true", 1, null])(
    "rejects invalid updateVersionTags %j before publishing",
    async (value) => {
      await writeFile(
        join(root, "release.json"),
        JSON.stringify({ packageFiles: [], updateVersionTags: value }),
      );

      await import("./index");
      await vi.waitFor(() => expect(setFailed).toHaveBeenCalled());

      expect(publish).not.toHaveBeenCalled();
    },
  );

  it.each(["missing", "malformed"])(
    "stops before publishing when the configuration is %s",
    async (state) => {
      if (state === "malformed") {
        await writeFile(join(root, "release.json"), "{");
      }

      await import("./index");
      await vi.waitFor(() => expect(setFailed).toHaveBeenCalled());

      expect(publish).not.toHaveBeenCalled();
    },
  );
});
