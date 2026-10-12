import type { Config } from "../services/config";
import type { ReleaseContext } from "../services/definitions";
import type { PreparationService } from "../services/preparation";
import type { ReleaseService } from "../services/releases";
import type { ReleaseType } from "../utils/version";

export type PrepareServices = {
  preparation: Pick<PreparationService, "plan" | "apply">;
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

  await services.releases.assertBaseCommit(context.defaultBranch, context.sha);

  const previousVersion = await services.releases.currentVersion(config.tagPrefix);
  const plan = await services.preparation.plan(config, context.sha, previousVersion, type);
  await services.releases.assertTagAvailable(plan.tag);
  const changes = await services.preparation.apply(config, plan);

  return services.releases.createPreparation({
    config,
    repository: context.repository,
    baseBranch: context.defaultBranch,
    baseCommit: context.sha,
    version: plan.version,
    tag: plan.tag,
    branch: plan.branch,
    changes,
  });
}
