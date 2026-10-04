import type { Config } from "../services/config";
import type { ReleaseContext } from "../services/definitions";
import type { PublishInput, ReleaseService } from "../services/releases";

import { draft, type DraftServices } from "./draft";

export function publish(releases: Pick<ReleaseService, "publish">, input: PublishInput) {
  return releases.publish(input);
}

export async function publishMerged(
  config: Config,
  context: ReleaseContext,
  services: DraftServices & { releases: Pick<ReleaseService, "ensureDraft" | "publish"> },
) {
  const release = await draft(config, context, services);

  if (!release.ready) {
    return release;
  }

  const published = await publish(services.releases, {
    releaseId: release.releaseId,
    tag: release.tag,
    commit: release.commit,
    versionTags: config.updateVersionTags ? { prefix: config.tagPrefix } : undefined,
  });

  return { ready: true as const, version: release.version, ...published };
}
