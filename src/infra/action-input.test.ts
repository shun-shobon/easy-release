import { describe, expect, it } from "vitest";

import { parsePublishInput } from "./action-input";

describe("parsePublishInput", () => {
  it("selects publication from the merge event when all inputs are omitted", () => {
    expect(parsePublishInput("", "", "")).toBeUndefined();
  });

  it("parses the complete draft output", () => {
    expect(parsePublishInput("9", "v1.2.3", "merge")).toEqual({
      releaseId: 9,
      tag: "v1.2.3",
      commit: "merge",
    });
  });

  it.each([
    ["9", "", ""],
    ["", "v1.2.3", ""],
    ["", "", "merge"],
    ["9", "v1.2.3", ""],
    ["9", "", "merge"],
    ["", "v1.2.3", "merge"],
    ["0", "v1.2.3", "merge"],
    ["-1", "v1.2.3", "merge"],
    ["1.5", "v1.2.3", "merge"],
    ["no", "v1.2.3", "merge"],
  ])("rejects incomplete or invalid inputs: %s / %s / %s", (id, tag, commit) => {
    expect(() => parsePublishInput(id, tag, commit)).toThrow();
  });
});
