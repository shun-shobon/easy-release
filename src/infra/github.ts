import { Octokit, RequestError } from "octokit";
import * as v from "valibot";

import type {
  GitReference,
  NewCommit,
  NewPullRequest,
  ReleaseRepository,
} from "../services/definitions";

type GitHubRelease = Awaited<ReturnType<Octokit["rest"]["repos"]["getRelease"]>>["data"];
type GitHubReference = Awaited<ReturnType<Octokit["rest"]["git"]["getRef"]>>["data"]["object"];

function toRelease(release: GitHubRelease) {
  return {
    id: release.id,
    tag: release.tag_name,
    commit: release.target_commitish,
    draft: release.draft,
    url: release.html_url,
  };
}

function toReference(reference: GitHubReference): GitReference {
  // Release tags must resolve to commits, not trees or blobs.
  if (reference.type !== "commit" && reference.type !== "tag") {
    throw new Error("The release reference must point to a commit or tag.");
  }

  return { type: reference.type, sha: reference.sha };
}

class GitHubHttpError extends Error {
  constructor(readonly status: number) {
    super(`GitHub API request failed (HTTP ${status})`);
  }
}

export class GitHub implements ReleaseRepository {
  private readonly octokit: Octokit;
  private readonly repository: { owner: string; repo: string };

  constructor(
    apiUrl: string,
    repository: string,
    token: string,
    fetcher: typeof fetch = fetch,
    timeoutMs: number = 30_000,
  ) {
    const nonempty = v.pipe(v.string(), v.minLength(1));
    const [owner, repo] = v.parse(v.strictTuple([nonempty, nonempty]), repository.split("/"));
    this.repository = { owner, repo };
    this.octokit = new Octokit({
      auth: token,
      baseUrl: apiUrl.replace(/\/$/, ""),
      request: { fetch: fetcher },
      retry: { enabled: false },
      throttle: { enabled: false },
    });

    this.octokit.hook.wrap("request", async (request, options) => {
      const signal = AbortSignal.timeout(timeoutMs);
      options.request = { ...options.request, signal };
      options.headers = {
        ...options.headers,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2026-03-10",
      };

      try {
        const response = await request(options);
        signal.throwIfAborted();

        return response;
      } catch (error) {
        if (!signal.aborted && error instanceof RequestError && error.response) {
          throw new GitHubHttpError(error.status);
        }

        throw new Error(
          signal.aborted ? "GitHub API request timed out" : "Failed to connect to the GitHub API",
        );
      }
    });
  }

  private async findRef(ref: string) {
    try {
      const { data } = await this.octokit.rest.git.getRef({ ...this.repository, ref });

      return toReference(data.object);
    } catch (error) {
      if (error instanceof GitHubHttpError && error.status === 404) {
        return undefined;
      }

      throw error;
    }
  }

  listTags() {
    return this.octokit.paginate(
      this.octokit.rest.repos.listTags,
      { ...this.repository, per_page: 100 },
      ({ data }) => data.map((tag) => tag.name),
    );
  }

  getBranch(branch: string) {
    return this.findRef(`heads/${branch}`);
  }

  getTag(tag: string) {
    return this.findRef(`tags/${tag}`);
  }

  async getAnnotatedTag(sha: string) {
    const { data } = await this.octokit.rest.git.getTag({ ...this.repository, tag_sha: sha });

    return toReference(data.object);
  }

  async getCommitMessage(sha: string) {
    const { data } = await this.octokit.rest.git.getCommit({ ...this.repository, commit_sha: sha });

    return data.message;
  }

  async createCommit(input: NewCommit) {
    const { data: parent } = await this.octokit.rest.git.getCommit({
      ...this.repository,
      commit_sha: input.parent,
    });
    const tree: Array<{
      path: string;
      mode: "100644" | "100755" | "120000";
      type: "blob";
      sha: string | null;
    }> = [];

    for (const change of input.changes) {
      let sha: string | null = null;

      if (change.content !== null) {
        const { data: blob } = await this.octokit.rest.git.createBlob({
          ...this.repository,
          content: Buffer.from(change.content).toString("base64"),
          encoding: "base64",
        });
        sha = blob.sha;
      }

      tree.push({ path: change.path, mode: change.mode, type: "blob", sha });
    }

    let treeSha = parent.tree.sha;

    if (tree.length > 0) {
      const { data: newTree } = await this.octokit.rest.git.createTree({
        ...this.repository,
        base_tree: parent.tree.sha,
        tree,
      });
      treeSha = newTree.sha;
    }

    const { data: commit } = await this.octokit.rest.git.createCommit({
      ...this.repository,
      message: input.message,
      tree: treeSha,
      parents: [input.parent],
    });

    return commit.sha;
  }

  listOpenPullRequests(base: string) {
    return this.octokit.paginate(
      this.octokit.rest.pulls.list,
      { ...this.repository, state: "open", base, per_page: 100 },
      ({ data }) =>
        data.map((pull) => ({
          number: pull.number,
          branch: pull.head.ref,
          repository: pull.head.repo?.full_name ?? null,
        })),
    );
  }

  async closePullRequest(number: number): Promise<void> {
    await this.octokit.rest.pulls.update({
      ...this.repository,
      pull_number: number,
      state: "closed",
    });
  }

  async deleteBranch(branch: string): Promise<void> {
    await this.octokit.rest.git.deleteRef({ ...this.repository, ref: `heads/${branch}` });
  }

  async createBranch(branch: string, commit: string): Promise<void> {
    await this.octokit.rest.git.createRef({
      ...this.repository,
      ref: `refs/heads/${branch}`,
      sha: commit,
    });
  }

  async createPullRequest(input: NewPullRequest) {
    const { data } = await this.octokit.rest.pulls.create({
      ...this.repository,
      base: input.base,
      head: input.branch,
      title: input.title,
      body: input.body,
    });

    return { number: data.number, url: data.html_url };
  }

  listReleases() {
    return this.octokit.paginate(
      this.octokit.rest.repos.listReleases,
      { ...this.repository, per_page: 100 },
      ({ data }) => data.map(toRelease),
    );
  }

  async getRelease(id: number) {
    const { data } = await this.octokit.rest.repos.getRelease({
      ...this.repository,
      release_id: id,
    });

    return toRelease(data);
  }

  async createTag(tag: string, commit: string): Promise<void> {
    await this.octokit.rest.git.createRef({
      ...this.repository,
      ref: `refs/tags/${tag}`,
      sha: commit,
    });
  }

  async createDraft(tag: string, commit: string) {
    const { data } = await this.octokit.rest.repos.createRelease({
      ...this.repository,
      tag_name: tag,
      target_commitish: commit,
      name: tag,
      draft: true,
      generate_release_notes: true,
    });

    return toRelease(data);
  }

  listAssets(releaseId: number) {
    return this.octokit.paginate(
      this.octokit.rest.repos.listReleaseAssets,
      { ...this.repository, release_id: releaseId, per_page: 100 },
      ({ data }) => data.map((asset) => ({ name: asset.name, state: asset.state })),
    );
  }

  async publishRelease(id: number) {
    const { data } = await this.octokit.rest.repos.updateRelease({
      ...this.repository,
      release_id: id,
      draft: false,
      make_latest: "true",
    });

    return toRelease(data);
  }
}
