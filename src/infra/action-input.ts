import * as v from "valibot";

import type { PublishInput } from "../services/releases";
import { nonempty } from "../utils/schema";

export function parsePublishInput(
  releaseId: string,
  tag: string,
  commit: string,
): PublishInput | undefined {
  if (releaseId === "" && tag === "" && commit === "") {
    return undefined;
  }

  return v.parse(
    v.object({
      releaseId: v.pipe(
        v.string(),
        v.transform(Number),
        v.number(),
        v.safeInteger(),
        v.minValue(1),
      ),
      tag: nonempty,
      commit: nonempty,
    }),
    { releaseId, tag, commit },
  );
}
