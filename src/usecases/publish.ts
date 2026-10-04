import type { PublishInput, ReleaseService } from "../services/releases";

export function publish(releases: Pick<ReleaseService, "publish">, input: PublishInput) {
  return releases.publish(input);
}
