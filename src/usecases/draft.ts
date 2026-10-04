import type { Config } from "../services/config";
import type { ReleaseContext } from "../services/definitions";
import type { PreparationService } from "../services/preparation";
import { managedBranch } from "../services/release-names";
import type { ReleaseService } from "../services/releases";

export type DraftServices = {
  preparation: Pick<PreparationService, "verifyMerged">;
  releases: Pick<ReleaseService, "ensureDraft">;
};

export async function draft(config: Config, context: ReleaseContext, services: DraftServices) {
  const event = context.event;

  if (event.kind !== "pull-request") {
    throw new Error("Run this mode from a pull_request event.");
  }

  if (
    event.action !== "closed" ||
    !event.merged ||
    event.baseBranch !== context.defaultBranch ||
    event.repository !== context.repository ||
    !managedBranch(config, event.branch)
  ) {
    return { ready: false as const };
  }

  if (!event.mergeCommit) {
    throw new Error("The merge commit is missing.");
  }

  const { version, tag } = await services.preparation.verifyMerged(
    config,
    event.mergeCommit,
    event.branch,
  );
  const release = await services.releases.ensureDraft(tag, event.mergeCommit);

  return { ready: true as const, version, ...release };
}
