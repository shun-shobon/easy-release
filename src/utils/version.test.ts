import { describe, expect, it } from "vitest";

import { bumpVersion, isStableVersion, latestVersion, versionTags } from "./version";

describe("versionTags", () => {
  it.each([
    ["v1.2.3", "v", ["v1", "v1.2"]],
    ["app/0.2.3", "app/", ["app/0", "app/0.2"]],
    ["1.0.0", "", ["1", "1.0"]],
    ["release21.2.3", "release2", ["release21", "release21.2"]],
  ])("derives major and minor tags from %s", (tag, prefix, expected) => {
    expect(versionTags(tag, prefix)).toEqual(expected);
  });

  it.each(["other1.2.3", "v1.2", "v01.2.3", "v1.2.3-rc.1", "v1.2.3+build", "v1.2.3\n"])(
    "rejects invalid release tag %j",
    (tag) => {
      expect(() => versionTags(tag, "v")).toThrow();
    },
  );
});

describe("isStableVersion", () => {
  it("accepts only canonical stable versions", () => {
    expect(isStableVersion("1.2.3")).toBe(true);

    for (const version of ["v1.2.3", "1.2.3-beta", "1.2.3+build", "1.2.3\n", "=1.2.3"]) {
      expect(isStableVersion(version)).toBe(false);
    }
  });
});

describe("bumpVersion", () => {
  it("increments the selected component and resets lower components", () => {
    expect(bumpVersion("1.2.3", "major")).toBe("2.0.0");
    expect(bumpVersion("1.2.3", "minor")).toBe("1.3.0");
    expect(bumpVersion("1.2.3", "patch")).toBe("1.2.4");
    expect(bumpVersion("0.0.0", "patch")).toBe("0.0.1");
  });

  it.each([
    "v1.2.3",
    "1.2",
    "01.2.3",
    "1.2.3-beta.1",
    "1.2.3+build",
    "1.2.3\n",
    "9007199254740992.0.0",
  ])("rejects invalid version %j", (version) => {
    expect(() => bumpVersion(version, "patch")).toThrow(/version/i);
  });

  it("rejects increments beyond the safe integer range", () => {
    expect(() => bumpVersion("9007199254740991.0.0", "major")).toThrow(/version/i);
    expect(() => bumpVersion("1.9007199254740991.0", "minor")).toThrow(/version/i);
    expect(() => bumpVersion("1.2.9007199254740991", "patch")).toThrow(/version/i);
  });
});

describe("latestVersion", () => {
  it("selects the highest SemVer regardless of tag or lexical order", () => {
    expect(latestVersion(["v1.9.0", "v1.10.0", "v1.2.0"], "v")).toBe("1.10.0");
  });

  it("uses only canonical stable tags matching the prefix", () => {
    expect(
      latestVersion(
        [
          "v1.2.3",
          "v99",
          "v99.99",
          "v9.0.0-beta.1",
          "v9.0.0+build",
          "v01.0.0",
          "other-9.0.0",
          "v9.0.0\n",
          "v9007199254740992.0.0",
        ],
        "v",
      ),
    ).toBe("1.2.3");
  });

  it("supports custom and empty prefixes", () => {
    expect(latestVersion(["app/1.2.3", "v9.0.0"], "app/")).toBe("1.2.3");
    expect(latestVersion(["1.2.3", "v9.0.0"], "")).toBe("1.2.3");
  });

  it.each([{ tags: [] }, { tags: ["other", "v1.0.0-rc.1"] }])(
    "starts from 0.0.0 when no tags match: %j",
    ({ tags }) => {
      expect(latestVersion(tags, "v")).toBe("0.0.0");
    },
  );
});
