import type { Config } from "../services/config";
import type { ReleaseContext } from "../services/definitions";
import type { PreparationService } from "../services/preparation";
import type { ReleaseService } from "../services/releases";
import type { ReleaseType } from "../utils/version";

export type PrepareServices = {
  preparation: Pick<PreparationService, "assertCheckout" | "updateVersions" | "finish">;
  releases: Pick<
    ReleaseService,
    "assertBaseCommit" | "currentVersion" | "assertTagAvailable" | "createPreparation"
  >;
};

export async function prepare(
  config: Config,
  context: ReleaseContext,
  services: PrepareServices,
  type: ReleaseType,
) {
  if (context.event.kind !== "dispatch" || context.ref !== `refs/heads/${context.defaultBranch}`) {
    throw new Error(`Run prepare with workflow_dispatch on ${context.defaultBranch}.`);
  }

  await services.preparation.assertCheckout(context.sha);
  await services.releases.assertBaseCommit(context.defaultBranch, context.sha);

  const previousVersion = await services.releases.currentVersion(config.tagPrefix);
  const updated = await services.preparation.updateVersions(config, previousVersion, type);
  await services.releases.assertTagAvailable(updated.tag);
  const changes = await services.preparation.finish(config, updated);

  return services.releases.createPreparation({
    config,
    repository: context.repository,
    baseBranch: context.defaultBranch,
    baseCommit: context.sha,
    version: updated.version,
    tag: updated.tag,
    branch: updated.branch,
    changes,
  });
}
