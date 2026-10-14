import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { ResolveError } from "../../../src/domain/resolve/resolve-errors";
import { ResolvedRepo } from "../../../src/domain/resolve/resolve-schema";
import { ResolveService } from "../../../src/domain/resolve/resolve-service";
import { startStubServices, type StubServices } from "../../helpers/stub-services";

const runWithService = <A, E>(effect: Effect.Effect<A, E, ResolveService>) =>
  Effect.runPromise(Effect.provide(effect, ResolveService.layer));

const runExitWithService = <A, E>(effect: Effect.Effect<A, E, ResolveService>) =>
  Effect.runPromiseExit(Effect.provide(effect, ResolveService.layer));

describe("ResolveService", () => {
  describe("resolve", () => {
    test("passes through HTTPS URLs directly", async () => {
      const result = await runWithService(
        Effect.gen(function* () {
          const service = yield* ResolveService;
          return yield* service.resolve("https://github.com/facebook/react.git");
        }),
      );
      expect(result.url).toBe("https://github.com/facebook/react.git");
      expect(result.source).toBe("direct");
    });

    test("passes through HTTP URLs directly", async () => {
      const result = await runWithService(
        Effect.gen(function* () {
          const service = yield* ResolveService;
          return yield* service.resolve("http://example.com/repo.git");
        }),
      );
      expect(result.url).toBe("http://example.com/repo.git");
      expect(result.source).toBe("direct");
    });

    test("passes through SSH URLs directly", async () => {
      const result = await runWithService(
        Effect.gen(function* () {
          const service = yield* ResolveService;
          return yield* service.resolve("git@github.com:facebook/react.git");
        }),
      );
      expect(result.url).toBe("git@github.com:facebook/react.git");
      expect(result.source).toBe("direct");
    });

    test("passes through local filesystem paths directly", async () => {
      const result = await runWithService(
        Effect.gen(function* () {
          const service = yield* ResolveService;
          return yield* service.resolve("/tmp/some-repo");
        }),
      );
      expect(result.url).toBe("/tmp/some-repo");
      expect(result.source).toBe("direct");
    });

    test("passes through relative paths directly", async () => {
      const result = await runWithService(
        Effect.gen(function* () {
          const service = yield* ResolveService;
          return yield* service.resolve("./local-repo");
        }),
      );
      expect(result.url).toBe("./local-repo");
      expect(result.source).toBe("direct");
    });

    test("passes through tilde paths directly", async () => {
      const result = await runWithService(
        Effect.gen(function* () {
          const service = yield* ResolveService;
          return yield* service.resolve("~/repos/my-lib");
        }),
      );
      expect(result.url).toBe("~/repos/my-lib");
      expect(result.source).toBe("direct");
    });

    test("expands owner/repo to GitHub URL", async () => {
      const result = await runWithService(
        Effect.gen(function* () {
          const service = yield* ResolveService;
          return yield* service.resolve("facebook/react");
        }),
      );
      expect(result.url).toBe("https://github.com/facebook/react.git");
      expect(result.suggestedAlias).toBe("react");
      expect(result.source).toBe("owner-repo");
    });

    test("expands github: prefixed input", async () => {
      const result = await runWithService(
        Effect.gen(function* () {
          const service = yield* ResolveService;
          return yield* service.resolve("github:vercel/next.js");
        }),
      );
      expect(result.url).toBe("https://github.com/vercel/next.js.git");
      expect(result.suggestedAlias).toBe("next.js");
      expect(result.source).toBe("prefixed");
    });

    test("expands gitlab: prefixed input", async () => {
      const result = await runWithService(
        Effect.gen(function* () {
          const service = yield* ResolveService;
          return yield* service.resolve("gitlab:org/repo");
        }),
      );
      expect(result.url).toBe("https://gitlab.com/org/repo.git");
      expect(result.source).toBe("prefixed");
    });

    test("expands bitbucket: prefixed input", async () => {
      const result = await runWithService(
        Effect.gen(function* () {
          const service = yield* ResolveService;
          return yield* service.resolve("bitbucket:org/repo");
        }),
      );
      expect(result.url).toBe("https://bitbucket.org/org/repo.git");
      expect(result.source).toBe("prefixed");
    });

    test("resolves bare names from built-in registry", async () => {
      const result = await runWithService(
        Effect.gen(function* () {
          const service = yield* ResolveService;
          return yield* service.resolve("react");
        }),
      );
      expect(result.url).toBe("https://github.com/facebook/react.git");
      expect(result.suggestedAlias).toBe("react");
      expect(result.source).toBe("registry");
    });

    test("resolves effect from built-in registry", async () => {
      const result = await runWithService(
        Effect.gen(function* () {
          const service = yield* ResolveService;
          return yield* service.resolve("effect");
        }),
      );
      expect(result.url).toBe("https://github.com/Effect-TS/effect.git");
      expect(result.suggestedAlias).toBe("effect");
      expect(result.source).toBe("registry");
    });

    test("resolves zod from built-in registry", async () => {
      const result = await runWithService(
        Effect.gen(function* () {
          const service = yield* ResolveService;
          return yield* service.resolve("zod");
        }),
      );
      expect(result.url).toBe("https://github.com/colinhacks/zod.git");
      expect(result.source).toBe("registry");
    });

    test("resolves Go libraries from registry", async () => {
      const result = await runWithService(
        Effect.gen(function* () {
          const service = yield* ResolveService;
          return yield* service.resolve("gin");
        }),
      );
      expect(result.url).toBe("https://github.com/gin-gonic/gin.git");
      expect(result.source).toBe("registry");
    });

    test("resolves Rust libraries from registry", async () => {
      const result = await runWithService(
        Effect.gen(function* () {
          const service = yield* ResolveService;
          return yield* service.resolve("tokio");
        }),
      );
      expect(result.url).toBe("https://github.com/tokio-rs/tokio.git");
      expect(result.source).toBe("registry");
    });

    test("resolves Python libraries from registry", async () => {
      const result = await runWithService(
        Effect.gen(function* () {
          const service = yield* ResolveService;
          return yield* service.resolve("fastapi");
        }),
      );
      expect(result.url).toBe("https://github.com/fastapi/fastapi.git");
      expect(result.source).toBe("registry");
    });

    test("suggested alias derived from URL for direct URLs", async () => {
      const result = await runWithService(
        Effect.gen(function* () {
          const service = yield* ResolveService;
          return yield* service.resolve("https://github.com/Effect-TS/effect.git");
        }),
      );
      expect(result.suggestedAlias).toBe("effect");
    });

    test("suggested alias derived from owner/repo", async () => {
      const result = await runWithService(
        Effect.gen(function* () {
          const service = yield* ResolveService;
          return yield* service.resolve("Effect-TS/effect");
        }),
      );
      expect(result.suggestedAlias).toBe("effect");
    });
  });

  describe("registry coverage", () => {
    test("all registry entries are valid git URLs", async () => {
      const { builtinRegistry } = await import("../../../src/domain/resolve/resolve-utils");
      for (const [name, url] of Object.entries(builtinRegistry)) {
        expect(url).toMatch(/^https:\/\//);
        expect(url).toMatch(/\.git$/);
        expect(name.length).toBeGreaterThan(0);
      }
    });

    test("registry has at least 50 entries", async () => {
      const { builtinRegistry } = await import("../../../src/domain/resolve/resolve-utils");
      expect(Object.keys(builtinRegistry).length).toBeGreaterThanOrEqual(50);
    });
  });

  describe("GitHub search and failures", () => {
    let stubs: StubServices | undefined;
    let server: Server | undefined;
    const setupGitHubUrl = process.env["SHELF_GITHUB_API_URL"];

    afterEach(async () => {
      process.env["SHELF_GITHUB_API_URL"] = setupGitHubUrl;
      await stubs?.stop();
      stubs = undefined;
      if (server) await new Promise((resolve) => server?.close(resolve));
      server = undefined;
    });

    /** A GitHub API that answers every request with this status and raw body. */
    const serveRaw = async (status: number, body: string): Promise<string> => {
      const raw = createServer((_request, response) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(body);
      });
      server = raw;
      await new Promise<void>((resolve) => raw.listen(0, "127.0.0.1", resolve));
      const { port } = raw.address() as AddressInfo;
      return `http://127.0.0.1:${port}`;
    };

    /** The ResolveError resolving `input` fails with, as plain fields (toEqual ignores an error's message). */
    const failureOf = async (input: string) => {
      const exit = await runExitWithService(
        Effect.gen(function* () {
          const service = yield* ResolveService;
          return yield* service.resolve(input);
        }),
      );
      if (Exit.isSuccess(exit)) throw new Error("expected resolve to fail");
      const error = Cause.squash(exit.cause);
      expect(error).toBeInstanceOf(ResolveError);
      const { _tag, input: failedInput, message } = error as ResolveError;
      return { _tag, input: failedInput, message };
    };

    const searchError = (message: string) => ({
      _tag: "ResolveError",
      input: "my-cool-lib",
      message,
    });

    test("takes the top GitHub search result, with an alias from the name", async () => {
      stubs = await startStubServices({
        github: {
          "my-cool-lib": [
            { clone_url: "https://github.com/someone/cool-lib.git", name: "cool-lib" },
            { clone_url: "https://github.com/other/cool-lib.git", name: "cool-lib" },
          ],
        },
      });
      process.env["SHELF_GITHUB_API_URL"] = stubs.githubUrl;
      const result = await runWithService(
        Effect.gen(function* () {
          const service = yield* ResolveService;
          return yield* service.resolve("my-cool-lib");
        }),
      );
      expect(result).toEqual(
        new ResolvedRepo({
          url: "https://github.com/someone/cool-lib.git",
          suggestedAlias: "my-cool-lib",
          source: "github-api",
        }),
      );
    });

    test("fails when the GitHub API can't be reached", async () => {
      const gone = await startStubServices();
      await gone.stop();
      process.env["SHELF_GITHUB_API_URL"] = gone.githubUrl;
      expect(await failureOf("my-cool-lib")).toEqual(searchError("Failed to reach GitHub API"));
    });

    test("fails with the status when the GitHub API answers with an error", async () => {
      process.env["SHELF_GITHUB_API_URL"] = await serveRaw(503, "{}");
      expect(await failureOf("my-cool-lib")).toEqual(
        searchError("GitHub API returned 503. Try: shelf add owner/repo or shelf add <full-url>"),
      );
    });

    test("fails when the GitHub API answers with something other than JSON", async () => {
      process.env["SHELF_GITHUB_API_URL"] = await serveRaw(200, "<html>rate limited</html>");
      expect(await failureOf("my-cool-lib")).toEqual(
        searchError("Failed to parse GitHub API response"),
      );
    });

    test("finds nothing when the GitHub API answer has no items", async () => {
      process.env["SHELF_GITHUB_API_URL"] = await serveRaw(200, "{}");
      expect(await failureOf("my-cool-lib")).toEqual(
        searchError(
          'No repositories found for "my-cool-lib". Try: shelf add owner/repo or shelf add <full-url>',
        ),
      );
    });

    test.each([
      ["null", "null"],
      ["a number", "42"],
      ["a string", '"rate limited"'],
      ["an object whose items is not an array", '{"items":"nope"}'],
      ["an item without a clone_url", '{"items":[{"name":"cool-lib"}]}'],
    ])("fails when the GitHub API answers with %s", async (_label, body) => {
      process.env["SHELF_GITHUB_API_URL"] = await serveRaw(200, body);
      expect(await failureOf("my-cool-lib")).toEqual(
        searchError("GitHub API returned an unexpected response"),
      );
    });

    test("an invalid input fails with the reason, without searching GitHub", async () => {
      process.env["SHELF_GITHUB_API_URL"] = await serveRaw(500, "{}");
      expect(await failureOf("ftp://example.com/repo.git")).toEqual({
        _tag: "ResolveError",
        input: "ftp://example.com/repo.git",
        message:
          '"ftp://example.com/repo.git" uses an unsupported URL scheme "ftp". Try: shelf add owner/repo or shelf add <full-url>',
      });
    });
  });

  describe("error handling", () => {
    test("fails with ResolveError when the GitHub API finds nothing for a bare name", async () => {
      // tests/setup.ts points SHELF_GITHUB_API_URL at a stub that finds nothing
      const exit = await runExitWithService(
        Effect.gen(function* () {
          const service = yield* ResolveService;
          return yield* service.resolve("xyzzy-nonexistent-library-12345");
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(String(Exit.isFailure(exit) && exit.cause)).toContain("No repositories found");
    });
  });
});
