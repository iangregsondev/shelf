// A local HTTP server that stands in for the npm registry and the GitHub API,
// so tests never touch the network. Point shelf at it with
// SHELF_NPM_REGISTRY_URL and SHELF_GITHUB_API_URL.

import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface GitHubSearchItem {
  readonly clone_url: string;
  readonly name: string;
}

export interface StubResponses {
  /** npm package name → the JSON document the registry returns for it. Unknown names get 404. */
  readonly npm?: Readonly<Record<string, unknown>>;
  /** GitHub search query → the repos it finds. Unknown queries find nothing. */
  readonly github?: Readonly<Record<string, ReadonlyArray<GitHubSearchItem>>>;
}

export interface StubServices {
  readonly npmUrl: string;
  readonly githubUrl: string;
  readonly stop: () => Promise<void>;
}

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

export const startStubServices = async (stubs: StubResponses = {}): Promise<StubServices> => {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname.startsWith("/npm/")) {
      const name = decodeURIComponent(url.pathname.slice("/npm/".length));
      const doc = stubs.npm && Object.hasOwn(stubs.npm, name) ? stubs.npm[name] : undefined;
      if (doc === undefined) sendJson(response, 404, { error: "Not found" });
      else sendJson(response, 200, doc);
      return;
    }
    if (url.pathname === "/github/search/repositories") {
      const query = url.searchParams.get("q") ?? "";
      const items = stubs.github && Object.hasOwn(stubs.github, query) ? stubs.github[query] : [];
      sendJson(response, 200, { total_count: items?.length ?? 0, items: items ?? [] });
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("Not found");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  // The test process must be able to exit with the setup stub still listening.
  server.unref();
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  return {
    npmUrl: `${base}/npm`,
    githubUrl: `${base}/github`,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        server.closeAllConnections();
      }),
  };
};
