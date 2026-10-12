import { execFile, spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";

import type { FileChange, FileMode, Workspace } from "../services/definitions";

const execute = promisify(execFile);
const gitTimeoutMs = 30_000;
const maxBuffer = 64 * 1024 * 1024;

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

export class GitWorkspace implements Workspace {
  constructor(private readonly root: string) {}

  private async git(args: string[]): Promise<Buffer> {
    const { stdout } = await execute("git", args, {
      cwd: this.root,
      encoding: "buffer",
      timeout: gitTimeoutMs,
      maxBuffer,
      killSignal: "SIGKILL",
    });

    return stdout;
  }

  async assertCheckout(sha: string): Promise<void> {
    const topLevel = (await this.git(["rev-parse", "--show-toplevel"]))
      .toString()
      .replace(/\n$/, "");
    if ((await realpath(this.root)) !== (await realpath(topLevel))) {
      throw new Error("The workspace must be the repository root.");
    }

    const head = (await this.git(["rev-parse", "HEAD"])).toString().trim();
    if (head !== sha) {
      throw new Error("Checkout HEAD does not match the requested commit.");
    }

    if ((await this.git(["status", "--porcelain"])).length !== 0) {
      throw new Error("The checkout must be clean before preparing a release.");
    }
  }

  async validateRefs(refs: string[]): Promise<void> {
    for (const ref of refs) {
      await this.git(["check-ref-format", ref]);
    }
  }

  async runUpdateCommand(command: string, previousVersion: string, version: string): Promise<void> {
    // Killing the process group with a negative PID is not available on Windows.
    if (process.platform !== "linux" && process.platform !== "darwin") {
      throw new Error("Update commands require a Linux or macOS runner.");
    }

    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "bash",
        ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", command],
        {
          cwd: this.root,
          env: { ...process.env, PREVIOUS_VERSION: previousVersion, RELEASE_VERSION: version },
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

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
            failure = new Error("Failed to terminate the update command process group.", {
              cause,
            });
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

  async collectChanges(): Promise<FileChange[]> {
    await this.git(["add", "--all"]);
    const fields = records(
      await this.git(["diff", "--cached", "--raw", "--no-renames", "--no-abbrev", "-z"]),
    );
    const changes: FileChange[] = [];

    for (let position = 0; position < fields.length; position += 2) {
      const match = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([AMDT])$/.exec(fields[position] ?? "");
      const path = fields[position + 1];
      if (!match || path === undefined) {
        throw new Error("Unsupported staged Git change.");
      }

      const [, previousMode, mode, status] = match;

      if (status === "D") {
        changes.push({ path, mode: fileMode(previousMode, path), content: null });
        continue;
      }

      // Reject replacing a submodule with a file.
      if (status !== "A") {
        fileMode(previousMode, path);
      }

      changes.push({
        path,
        mode: fileMode(mode, path),
        content: await this.git(["show", `:${path}`]),
      });
    }

    return changes;
  }
}
