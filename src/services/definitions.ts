export type FileChange = {
  path: string;
  mode: "100644" | "100755" | "120000";
  content: Uint8Array | null;
};

export interface PackageFileStore {
  resolve(patterns: string[]): Promise<string[]>;
  read(file: string): Promise<string>;
  write(file: string, content: string): Promise<void>;
}

export interface Workspace {
  assertCheckout(commit: string): Promise<void>;
  validateRefs(refs: string[]): Promise<void>;
  runUpdateCommand(command: string, previousVersion: string, version: string): Promise<void>;
  collectChanges(): Promise<FileChange[]>;
}

export type GitReference = { type: "commit" | "tag"; sha: string };
export type PullRequest = { number: number; branch: string; repository: string | null };
export type Release = { id: number; tag: string; commit: string; draft: boolean; url: string };
export type ReleaseAsset = { name: string; state: string };
export type NewPullRequest = { base: string; branch: string; title: string; body: string };
export type NewCommit = { parent: string; message: string; changes: FileChange[] };

export interface ReleaseRepository {
  listTags(): Promise<string[]>;
  getBranch(branch: string): Promise<GitReference | undefined>;
  getTag(tag: string): Promise<GitReference | undefined>;
  getAnnotatedTag(sha: string): Promise<GitReference>;
  getCommitMessage(sha: string): Promise<string>;
  createCommit(input: NewCommit): Promise<string>;
  listOpenPullRequests(base: string): Promise<PullRequest[]>;
  closePullRequest(number: number): Promise<void>;
  deleteBranch(branch: string): Promise<void>;
  createBranch(branch: string, commit: string): Promise<void>;
  createPullRequest(input: NewPullRequest): Promise<{ number: number; url: string }>;
  listReleases(): Promise<Release[]>;
  getRelease(id: number): Promise<Release>;
  createTag(tag: string, commit: string): Promise<void>;
  createDraft(tag: string, commit: string): Promise<Release>;
  listAssets(releaseId: number): Promise<ReleaseAsset[]>;
  publishRelease(id: number): Promise<Release>;
}

export type ReleaseEvent =
  | { kind: "dispatch" }
  | { kind: "other"; name: string }
  | {
      kind: "pull-request";
      action: string;
      merged: boolean;
      mergeCommit: string | null;
      baseBranch: string;
      branch: string;
      repository: string | null;
    };

export type ReleaseContext = {
  repository: string;
  defaultBranch: string;
  sha: string;
  ref: string;
  event: ReleaseEvent;
};
