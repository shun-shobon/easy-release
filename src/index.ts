import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { getInput, info, setFailed, setOutput, setSecret } from "@actions/core";
import * as v from "valibot";

import { parseDefaultBranch, parseReleaseEvent } from "./infra/action-event";
import { parsePublishInput } from "./infra/action-input";
import { GitHub } from "./infra/github";
import { FileSystemPackages } from "./infra/package-files";
import { createWorkspace } from "./infra/workspace";
import { configSchema } from "./services/config";
import { PackageService } from "./services/packages";
import { PreparationService } from "./services/preparation";
import { ReleaseService } from "./services/releases";
import { draft } from "./usecases/draft";
import { prepare } from "./usecases/prepare";
import { publish, publishMerged } from "./usecases/publish";

async function main() {
  const mode = v.parse(
    v.picklist(["prepare", "draft", "publish"]),
    getInput("mode", { required: true }),
  );

  const token = getInput("token", { required: true });
  setSecret(token);

  const nonempty = v.pipe(v.string(), v.minLength(1));
  const environment = v.parse(
    v.object({
      GITHUB_API_URL: v.pipe(v.string(), v.url()),
      GITHUB_REPOSITORY: v.pipe(v.string(), v.regex(/^[\w.-]+\/[\w.-]+$/)),
      GITHUB_WORKSPACE: nonempty,
    }),
    process.env,
  );
  const github = new GitHub(environment.GITHUB_API_URL, environment.GITHUB_REPOSITORY, token);
  const releases = new ReleaseService(github);

  const root = resolve(environment.GITHUB_WORKSPACE);
  const configPath = resolve(root, getInput("config", { required: true }));
  const configSource = await readFile(configPath, "utf8");
  const config = v.parse(configSchema, JSON.parse(configSource));

  let outputs: Record<string, string | number | boolean>;
  const publishInput =
    mode === "publish"
      ? parsePublishInput(getInput("release-id"), getInput("tag"), getInput("commit"))
      : undefined;

  if (publishInput) {
    outputs = await publish(releases, {
      ...publishInput,
      versionTags: config.updateVersionTags ? { prefix: config.tagPrefix } : undefined,
    });
  } else {
    const checkout = v.parse(
      v.object({
        GITHUB_EVENT_NAME: nonempty,
        GITHUB_EVENT_PATH: nonempty,
        GITHUB_SHA: nonempty,
        GITHUB_REF: nonempty,
      }),
      process.env,
    );

    const eventSource = await readFile(checkout.GITHUB_EVENT_PATH, "utf8");
    const event: unknown = JSON.parse(eventSource);

    const context = {
      repository: environment.GITHUB_REPOSITORY,
      defaultBranch: parseDefaultBranch(event),
      event: parseReleaseEvent(checkout.GITHUB_EVENT_NAME, event),
      sha: checkout.GITHUB_SHA,
      ref: checkout.GITHUB_REF,
    };

    const packages = new PackageService(new FileSystemPackages(root));
    const preparation = new PreparationService(createWorkspace(root), packages);
    const services = { preparation, releases };

    if (mode === "prepare") {
      const type = v.parse(
        v.picklist(["major", "minor", "patch"]),
        getInput("release-type", { required: true }),
      );
      outputs = await prepare(config, context, services, type);
    } else if (mode === "draft") {
      outputs = await draft(config, context, services);
    } else {
      outputs = await publishMerged(config, context, services);
    }
  }

  for (const [name, value] of Object.entries(outputs)) {
    setOutput(
      name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
      value,
    );
  }

  info(`${mode} completed.`);
}

main().catch((error: unknown) => {
  setFailed(error instanceof Error ? error.message : "Release failed.");
});
