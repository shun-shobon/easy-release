import type { Config } from "../services/config";
import type { ReleaseContext } from "../services/definitions";
import type { ReleaseService } from "../services/releases";

import { draft, type DraftServices } from "./draft";

export async function publishMerged(
  config: Config,
  context: ReleaseContext,
  services: DraftServices & { releases: Pick<ReleaseService, "ensureDraft" | "publish"> },
) {
  const release = await draft(config, context, services);

  if (!release.ready) {
    return release;
  }

  const published = await services.releases.publish({
    releaseId: release.releaseId,
    tag: release.tag,
    commit: release.commit,
    versionTags: config.updateVersionTags ? { prefix: config.tagPrefix } : undefined,
  });

  return { ready: true as const, version: release.version, ...published };
}
