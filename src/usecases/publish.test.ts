import { describe, expect, it, vi } from "vitest";

import type { ReleaseService } from "../services/releases";

import { publish } from "./publish";

describe("publish", () => {
  it("delegates publishing to the service", async () => {
    const input = { releaseId: 9, tag: "v1.2.3", commit: "a".repeat(40) };
    const result = { ...input, releaseUrl: "https://github.com/o/r/releases/9" };
    const releases = { publish: vi.fn<ReleaseService["publish"]>().mockResolvedValue(result) };

    await expect(publish(releases, input)).resolves.toEqual(result);
    expect(releases.publish).toHaveBeenCalledWith(input);
  });
});
