import * as v from "valibot";

import type { ReleaseEvent } from "../services/definitions";

const nonempty = v.pipe(v.string(), v.minLength(1));
const pullEventSchema = v.object({
  action: nonempty,
  pull_request: v.object({
    merged: v.boolean(),
    merge_commit_sha: v.nullable(nonempty),
    base: v.object({ ref: nonempty }),
    head: v.object({ ref: nonempty, repo: v.nullable(v.object({ full_name: nonempty })) }),
  }),
});

export function parseDefaultBranch(value: unknown): string {
  const event = v.parse(v.object({ repository: v.object({ default_branch: nonempty }) }), value);

  return event.repository.default_branch;
}

export function parseReleaseEvent(name: string, value: unknown): ReleaseEvent {
  if (name === "workflow_dispatch") {
    return { kind: "dispatch" };
  }

  if (name !== "pull_request") {
    return { kind: "other", name };
  }

  const event = v.parse(pullEventSchema, value);
  const pull = event.pull_request;

  return {
    kind: "pull-request",
    action: event.action,
    merged: pull.merged,
    mergeCommit: pull.merge_commit_sha,
    baseBranch: pull.base.ref,
    branch: pull.head.ref,
    repository: pull.head.repo?.full_name ?? null,
  };
}
