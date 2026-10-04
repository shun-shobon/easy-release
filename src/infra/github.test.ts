import { describe, expect, it, vi } from "vitest";

import { GitHub } from "./github";

const sha = "a".repeat(40);
const release = {
  id: 1,
  tag_name: "v1.2.3",
  target_commitish: sha,
  draft: true,
  html_url: "https://github.com/owner/repo/releases/1",
};
const reference = { object: { type: "commit", sha } };

function client(fetcher: typeof fetch, timeoutMs = 30_000) {
  return new GitHub("https://api.github.com", "owner/repo", "secret", fetcher, timeoutMs);
}

describe("GitHub", () => {
  it("force updates an existing tag with updateRef", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(reference));

    await client(fetcher).updateTag("app/v1", sha);

    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/repos/owner/repo/git/refs/tags%2Fapp%2Fv1",
    );
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: "PATCH",
      body: JSON.stringify({ sha, force: true }),
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([403, 404, 422, 503])(
    "rejects HTTP %i when updating a tag without retrying or creating it",
    async (status) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ message: "secret" }, { status }));

      await expect(client(fetcher).updateTag("v1", sha)).rejects.toThrow(`HTTP ${status}`);

      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["network", "timeout"])("stops tag updates on a %s failure", async (failure) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      if (failure === "network") {
        throw new Error("secret");
      }

      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("secret")), { once: true });
      });
    });

    await expect(client(fetcher, 50).updateTag("v1", sha)).rejects.toThrow(
      failure === "network" ? "connect" : "timed out",
    );

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("creates an empty commit using the parent tree without creating blobs or a tree", async () => {
    const tree = "b".repeat(40);
    const commit = "c".repeat(40);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ tree: { sha: tree } }))
      .mockResolvedValueOnce(Response.json({ sha: commit }));

    await expect(
      client(fetcher).createCommit({ parent: sha, message: "prepare release", changes: [] }),
    ).resolves.toBe(commit);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[0]).toBe("https://api.github.com/repos/owner/repo/git/commits");
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ message: "prepare release", tree, parents: [sha] }),
    });
  });

  it.each(["network", "timeout"])(
    "stops empty commit creation on a %s failure",
    async (failure) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(Response.json({ tree: { sha } }))
        .mockImplementation(async (_input, init) => {
          if (failure === "network") {
            throw new Error("secret");
          }

          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("secret")), {
              once: true,
            });
          });
        });

      await expect(
        client(fetcher, 50).createCommit({ parent: sha, message: "prepare release", changes: [] }),
      ).rejects.toThrow(failure === "network" ? "connect" : "timed out");

      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );

  it("creates a draft with createRelease and maps the API response", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(release));
    const github = new GitHub("https://api.example.com/api/v3/", "owner/repo", "secret", fetcher);

    await expect(github.createDraft("v1.2.3", sha)).resolves.toEqual({
      id: 1,
      tag: "v1.2.3",
      commit: sha,
      draft: true,
      url: release.html_url,
    });

    const call = fetcher.mock.calls[0];
    expect(call?.[0]).toBe("https://api.example.com/api/v3/repos/owner/repo/releases");
    expect(call?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        tag_name: "v1.2.3",
        target_commitish: sha,
        name: "v1.2.3",
        draft: true,
        generate_release_notes: true,
      }),
      signal: expect.any(AbortSignal),
    });

    const headers = new Headers(call?.[1]?.headers);
    expect(headers.get("authorization")).toBe("token secret");
    expect(headers.get("x-github-api-version")).toBe("2026-03-10");
    expect(headers.get("user-agent")).toContain("octokit.js/");
  });

  it("handles a 204 response from deleteRef", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));

    await expect(client(fetcher).deleteBranch("release/prepare-v1.2.3")).resolves.toBeUndefined();
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe("DELETE");
  });

  it.each([401, 403, 404, 500, 502, 503])(
    "rejects HTTP %i without exposing the response body",
    async (status) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ message: "secret" }, { status }));
      const request = client(fetcher).getRelease(1);

      await expect(request).rejects.toThrow(`HTTP ${status}`);
      await expect(request).rejects.not.toThrow("secret");
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it("treats 404 as missing only when looking up refs", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(null, { status: 404 }));
    const github = client(fetcher);

    await expect(github.getTag("v1.2.3")).resolves.toBeUndefined();
    await expect(github.getBranch("main")).resolves.toBeUndefined();
    await expect(github.getRelease(1)).rejects.toThrow("HTTP 404");
  });

  it.each([401, 403, 500])("does not ignore HTTP %i when looking up refs", async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }));

    await expect(client(fetcher).getTag("v1.2.3")).rejects.toThrow(`HTTP ${status}`);
  });

  it("maps the getRef response to a reference", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(reference));

    await expect(client(fetcher).getTag("v1.2.3")).resolves.toEqual({ type: "commit", sha });
  });

  it("does not retry failed API mutations", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ message: "unavailable" }, { status: 503 }));

    await expect(client(fetcher).createDraft("v1.2.3", sha)).rejects.toThrow("HTTP 503");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not expose network error details", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("secret"));
    const request = client(fetcher).getRelease(1);

    await expect(request).rejects.toThrow("connect");
    await expect(request).rejects.not.toThrow("secret");
  });

  it("aborts the request on timeout", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("secret")), {
            once: true,
          });
        }),
    );

    await expect(client(fetcher, 5).getRelease(1)).rejects.toThrow("timed out");
  });

  it("enforces the timeout while reading the response body", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      const body = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(new Error("secret")), {
            once: true,
          });
        },
      });

      return new Response(body, { headers: { "content-type": "application/json" } });
    });

    await expect(client(fetcher, 5).getRelease(1)).rejects.toThrow("timed out");
  });

  it("passes the base branch to pulls.list and fetches all pages", async () => {
    const pull = {
      number: 1,
      head: { ref: "release/prepare-v1.2.3", repo: { full_name: "owner/repo" } },
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          Array.from({ length: 100 }, (_, i) => ({ ...pull, number: i + 1 })),
          {
            headers: {
              link: '<https://api.github.com/repos/owner/repo/pulls?state=open&base=main&per_page=100&page=2>; rel="next"',
            },
          },
        ),
      )
      .mockResolvedValueOnce(Response.json([{ ...pull, number: 101 }]));

    const pulls = await client(fetcher).listOpenPullRequests("main");

    expect(pulls).toHaveLength(101);
    expect(pulls[100]).toEqual({ number: 101, branch: pull.head.ref, repository: "owner/repo" });
    expect(
      fetcher.mock.calls.map(([url]) => (url instanceof Request ? url.url : url.toString())),
    ).toEqual([
      "https://api.github.com/repos/owner/repo/pulls?state=open&base=main&per_page=100",
      "https://api.github.com/repos/owner/repo/pulls?state=open&base=main&per_page=100&page=2",
    ]);
  });

  it("stops without a next link even when the last page has 100 items", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(Array.from({ length: 100 }, (_, i) => ({ ...release, id: i + 1 }))),
      );

    await expect(client(fetcher).listReleases()).resolves.toHaveLength(100);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("follows the next Link for assets", async () => {
    const next = "https://api.github.com/repos/owner/repo/releases/1/assets?per_page=100&page=2";
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json([{ name: "one", state: "uploaded" }], {
          headers: { link: `<${next}>; rel="next"` },
        }),
      )
      .mockResolvedValueOnce(Response.json([{ name: "two", state: "uploaded" }]));

    await expect(client(fetcher).listAssets(1)).resolves.toEqual([
      { name: "one", state: "uploaded" },
      { name: "two", state: "uploaded" },
    ]);
    expect(fetcher.mock.calls[1]?.[0]).toBe(next);
  });

  it.each([404, 503])(
    "rejects HTTP %i on later pages without returning partial results",
    async (status) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          Response.json([release], {
            headers: {
              link: '<https://api.github.com/repos/owner/repo/releases?per_page=100&page=2>; rel="next"',
            },
          }),
        )
        .mockResolvedValueOnce(Response.json({ message: "secret" }, { status }));

      await expect(client(fetcher).listReleases()).rejects.toThrow(`HTTP ${status}`);
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );

  it("fetches tag names from all pages", async () => {
    const next = "https://api.github.com/repos/owner/repo/tags?per_page=100&page=2";
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json([{ name: "v1.9.0" }], { headers: { link: `<${next}>; rel="next"` } }),
      )
      .mockResolvedValueOnce(Response.json([{ name: "v1.10.0" }]));

    await expect(client(fetcher).listTags()).resolves.toEqual(["v1.9.0", "v1.10.0"]);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/repos/owner/repo/tags?per_page=100",
    );
    expect(fetcher.mock.calls[1]?.[0]).toBe(next);
  });

  it("does not treat a failed tag listing as an empty list", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ message: "secret" }, { status: 503 }));

    await expect(client(fetcher).listTags()).rejects.toThrow("HTTP 503");
  });

  it("stops on an empty page", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json([]));

    await expect(client(fetcher).listReleases()).resolves.toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(["tree", "blob"])("rejects %s references as release targets", async (type) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ object: { type, sha } }));

    await expect(client(fetcher).getTag("v1.2.3")).rejects.toThrow("commit or tag");
  });

  it("creates commits with binary files and deletions using Git Database methods", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ tree: { sha } }))
      .mockResolvedValueOnce(Response.json({ sha }))
      .mockResolvedValueOnce(Response.json({ sha }))
      .mockResolvedValueOnce(Response.json({ sha }));

    await expect(
      client(fetcher).createCommit({
        parent: sha,
        message: "update",
        changes: [
          { path: "file.bin", mode: "100755", content: new Uint8Array([0, 255]) },
          { path: "old.txt", mode: "100644", content: null },
        ],
      }),
    ).resolves.toBe(sha);

    expect(fetcher.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({ content: "AP8=", encoding: "base64" }),
    );
    expect(fetcher.mock.calls[2]?.[1]?.body).toBe(
      JSON.stringify({
        base_tree: sha,
        tree: [
          { path: "file.bin", mode: "100755", type: "blob", sha },
          { path: "old.txt", mode: "100644", type: "blob", sha: null },
        ],
      }),
    );
  });
});
