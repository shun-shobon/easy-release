import { execFile, spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";

import type { FileChange, Workspace } from "../services/definitions";

const execute = promisify(execFile);
const gitTimeoutMs = 30_000;
const maxBuffer = 64 * 1024 * 1024;

type FileMode = "100644" | "100755" | "120000";
type Change = FileChange;

export function createWorkspace(root: string): Workspace {
  return {
    assertCheckout: (commit) => assertCheckout(root, commit),
    validateRefs: (refs) => validateRefs(root, refs),
    runUpdateCommand: (command, previousVersion, version) =>
      runUpdateCommand(root, command, previousVersion, version),
    collectChanges: () => collectChanges(root),
  };
}

async function git(root: string, args: string[]): Promise<Buffer> {
  const { stdout } = await execute("git", args, {
    cwd: root,
    encoding: "buffer",
    timeout: gitTimeoutMs,
    maxBuffer,
    killSignal: "SIGKILL",
  });

  return stdout;
}

export async function assertCheckout(root: string, sha: string): Promise<void> {
  const topLevel = (await git(root, ["rev-parse", "--show-toplevel"]))
    .toString()
    .replace(/\n$/, "");
  if ((await realpath(root)) !== (await realpath(topLevel))) {
    throw new Error("The workspace must be the repository root.");
  }

  const head = (await git(root, ["rev-parse", "HEAD"])).toString().trim();
  if (head !== sha) {
    throw new Error("Checkout HEAD does not match the requested commit.");
  }

  if ((await git(root, ["status", "--porcelain"])).length !== 0) {
    throw new Error("The checkout must be clean before preparing a release.");
  }
}

export async function validateRefs(root: string, refs: string[]): Promise<void> {
  for (const ref of refs) {
    await git(root, ["check-ref-format", ref]);
  }
}

export async function runUpdateCommand(
  root: string,
  command: string,
  previousVersion: string,
  version: string,
): Promise<void> {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    throw new Error("Update commands require a Linux or macOS runner.");
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", command], {
      cwd: root,
      env: { ...process.env, PREVIOUS_VERSION: previousVersion, RELEASE_VERSION: version },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let failure: Error | undefined;
    let outputBytes = 0;

    function terminate(error: Error): void {
      if (failure) {
        return;
      }
      failure = error;
      if (child.pid === undefined) {
        return;
      }

      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (cause) {
        if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) {
          failure = new Error("Failed to terminate the update command process group.", { cause });
          reject(failure);
        }
      }
    }

    function accountOutput(chunk: Buffer): void {
      outputBytes += chunk.length;
      if (outputBytes > maxBuffer) {
        terminate(new Error("The update command exceeded its output limit."));
      }
    }

    child.stdout.on("data", accountOutput);
    child.stderr.on("data", accountOutput);
    child.stdout.pipe(process.stdout, { end: false });
    child.stderr.pipe(process.stderr, { end: false });
    child.once("error", reject);

    child.once("exit", (code, signal) => {
      if (code !== 0) {
        terminate(new Error(`The update command failed (exit ${code}, signal ${signal}).`));
      }
    });

    child.once("close", () => {
      if (failure) {
        reject(failure);
      } else {
        resolve();
      }
    });
  });
}

function fileMode(value: string | undefined, path: string): FileMode {
  if (value === "100644" || value === "100755" || value === "120000") {
    return value;
  }

  throw new Error(
    `Unsupported Git mode ${value} for ${path}; submodule changes are not supported.`,
  );
}

function records(output: Buffer): string[] {
  if (output.length === 0) {
    return [];
  }

  const items = output.toString("utf8").split("\0");
  if (items.pop() !== "") {
    throw new Error("Invalid NUL-terminated Git output.");
  }

  return items;
}

export async function collectChanges(root: string): Promise<Change[]> {
  await git(root, ["add", "--all"]);
  const changes = records(
    await git(root, ["diff", "--cached", "--no-renames", "--name-status", "-z"]),
  );
  const index = new Map<string, string>();

  for (const entry of records(await git(root, ["ls-files", "--stage", "-z"]))) {
    const match = /^(\d+) [0-9a-f]+ 0\t([\s\S]+)$/.exec(entry);
    if (match?.[1] === undefined || match[2] === undefined) {
      throw new Error("Invalid Git index entry.");
    }
    index.set(match[2], match[1]);
  }

  const result: Change[] = [];

  for (let position = 0; position < changes.length; position += 2) {
    const status = changes[position];
    const path = changes[position + 1];
    if (path === undefined || status === undefined || !["A", "M", "D", "T"].includes(status)) {
      throw new Error("Unsupported staged Git change.");
    }

    let previousMode: FileMode | undefined;
    if (status !== "A") {
      const entries = records(
        await git(root, ["ls-tree", "-z", "HEAD", "--", `:(literal)${path}`]),
      );
      previousMode = fileMode(entries[0]?.split(" ")[0], path);
    }

    if (status === "D") {
      result.push({ path, mode: fileMode(previousMode, path), content: null });
    } else {
      const mode = fileMode(index.get(path), path);
      const content = await git(root, ["show", `:${path}`]);
      result.push({ path, mode, content });
    }
  }

  return result;
}
