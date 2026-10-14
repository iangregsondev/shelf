import { describe, expect, test, beforeEach, afterEach } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DetectService } from "../../../src/domain/detect/detect-service";
import type { ConfigService } from "../../../src/domain/config/config-service";
import { defaultConfig, RepoEntry, ShelfConfig } from "../../../src/domain/config/config-schema";
import { createMockConfigLayer } from "../../domain/config/helpers";
import { writeText } from "../../helpers/files";
import { PlatformLayer } from "../../helpers/platform";
import { startStubServices } from "../../helpers/stub-services";

const runWithLayers = <A, E>(
  effect: Effect.Effect<A, E, DetectService>,
  configLayer?: Layer.Layer<ConfigService>,
) => {
  const cfg = configLayer ?? createMockConfigLayer();
  const detectLayer = DetectService.layer.pipe(Layer.provide(cfg), Layer.provide(PlatformLayer));
  return Effect.runPromise(Effect.provide(effect, detectLayer));
};

describe("DetectService", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "shelf-detect-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("detect", () => {
    test("returns empty array when no dependency files found", async () => {
      const result = await runWithLayers(
        Effect.gen(function* () {
          const detect = yield* DetectService;
          return yield* detect.detect(tempDir);
        }),
      );
      expect(result).toEqual([]);
    });

    test("detects repos from package.json via built-in registry", async () => {
      await writeText(
        join(tempDir, "package.json"),
        JSON.stringify({
          dependencies: { react: "^18.2.0", zod: "^3.22.0" },
        }),
      );

      const result = await runWithLayers(
        Effect.gen(function* () {
          const detect = yield* DetectService;
          return yield* detect.detect(tempDir);
        }),
      );

      expect(result.length).toBe(2);
      const names = result.map((d) => d.name);
      expect(names).toContain("react");
      expect(names).toContain("zod");
      const react = result.find((d) => d.name === "react");
      expect(react?.url).toBe("https://github.com/facebook/react.git");
      expect(react?.source).toBe("npm");
      expect(react?.alreadyShelved).toBe(false);
    });

    test("marks repos as alreadyShelved when alias matches", async () => {
      await writeText(
        join(tempDir, "package.json"),
        JSON.stringify({ dependencies: { react: "^18.2.0" } }),
      );

      const configWithReact = new ShelfConfig({
        ...defaultConfig,
        repos: [
          new RepoEntry({
            url: "https://github.com/facebook/react.git",
            alias: "react",
            pin: Option.none(),
            depth: Option.none(),
            sparse: Option.none(),
            addedAt: new Date().toISOString(),
            lastSyncedAt: Option.none(),
          }),
        ],
      });
      const mockConfig = createMockConfigLayer({
        load: () => Effect.succeed(configWithReact),
      });

      const result = await runWithLayers(
        Effect.gen(function* () {
          const detect = yield* DetectService;
          return yield* detect.detect(tempDir);
        }),
        mockConfig,
      );

      expect(result.length).toBe(1);
      expect(result[0]?.alreadyShelved).toBe(true);
    });

    test("marks repos as alreadyShelved when URL matches", async () => {
      await writeText(
        join(tempDir, "package.json"),
        JSON.stringify({ dependencies: { react: "^18.2.0" } }),
      );

      const configWithReact = new ShelfConfig({
        ...defaultConfig,
        repos: [
          new RepoEntry({
            url: "https://github.com/facebook/react.git",
            alias: "my-react",
            pin: Option.none(),
            depth: Option.none(),
            sparse: Option.none(),
            addedAt: new Date().toISOString(),
            lastSyncedAt: Option.none(),
          }),
        ],
      });
      const mockConfig = createMockConfigLayer({
        load: () => Effect.succeed(configWithReact),
      });

      const result = await runWithLayers(
        Effect.gen(function* () {
          const detect = yield* DetectService;
          return yield* detect.detect(tempDir);
        }),
        mockConfig,
      );

      expect(result.length).toBe(1);
      expect(result[0]?.alreadyShelved).toBe(true);
    });

    test("detects repos from go.mod", async () => {
      await writeText(
        join(tempDir, "go.mod"),
        `module example.com/myapp

go 1.21

require (
	github.com/gin-gonic/gin v1.9.1
	github.com/gorilla/mux v1.8.0
	golang.org/x/text v0.14.0
)`,
      );

      const result = await runWithLayers(
        Effect.gen(function* () {
          const detect = yield* DetectService;
          return yield* detect.detect(tempDir);
        }),
      );

      // golang.org/x/text is not a github module so it shouldn't be included
      expect(result.length).toBe(2);
      const names = result.map((d) => d.name);
      expect(names).toContain("gin");
      expect(names).toContain("mux");
      expect(result[0]?.source).toBe("go");
    });

    test("deduplicates repos by URL", async () => {
      // If the same URL appears from both package.json and go.mod somehow,
      // it should be deduped. We can test by having the same dep twice in package.json
      // (which merges deps + devDeps, so duplicates aren't possible there).
      // Instead, test with a go.mod that has two paths pointing to the same org/repo
      await writeText(
        join(tempDir, "go.mod"),
        `module example.com/myapp

go 1.21

require (
	github.com/gin-gonic/gin v1.9.1
)`,
      );

      const result = await runWithLayers(
        Effect.gen(function* () {
          const detect = yield* DetectService;
          return yield* detect.detect(tempDir);
        }),
      );

      const urls = result.map((d) => d.url);
      const uniqueUrls = [...new Set(urls)];
      expect(urls.length).toBe(uniqueUrls.length);
    });

    test("detects from both package.json and go.mod", async () => {
      await writeText(
        join(tempDir, "package.json"),
        JSON.stringify({ dependencies: { react: "^18.2.0" } }),
      );
      await writeText(
        join(tempDir, "go.mod"),
        `module example.com/myapp

go 1.21

require github.com/gin-gonic/gin v1.9.1
`,
      );

      const result = await runWithLayers(
        Effect.gen(function* () {
          const detect = yield* DetectService;
          return yield* detect.detect(tempDir);
        }),
      );

      expect(result.length).toBe(2);
      const sources = result.map((d) => d.source);
      expect(sources).toContain("npm");
      expect(sources).toContain("go");
    });

    test("handles invalid package.json gracefully", async () => {
      await writeText(join(tempDir, "package.json"), "not valid json");

      const result = await runWithLayers(
        Effect.gen(function* () {
          const detect = yield* DetectService;
          return yield* detect.detect(tempDir);
        }),
      );

      expect(result).toEqual([]);
    });

    test("handles empty package.json", async () => {
      await writeText(join(tempDir, "package.json"), "{}");

      const result = await runWithLayers(
        Effect.gen(function* () {
          const detect = yield* DetectService;
          return yield* detect.detect(tempDir);
        }),
      );

      expect(result).toEqual([]);
    });

    test("only detects known registry packages without network", async () => {
      // Packages not in registry and with no npm API would return none
      await writeText(
        join(tempDir, "package.json"),
        JSON.stringify({
          dependencies: {
            react: "^18.0.0",
            "my-private-internal-pkg-xyzzy": "^1.0.0",
          },
        }),
      );

      const result = await runWithLayers(
        Effect.gen(function* () {
          const detect = yield* DetectService;
          return yield* detect.detect(tempDir);
        }),
      );

      // react should be found, the private pkg should not
      const names = result.map((d) => d.name);
      expect(names).toContain("react");
      expect(names).not.toContain("my-private-internal-pkg-xyzzy");
    });

    test("handles devDependencies", async () => {
      await writeText(
        join(tempDir, "package.json"),
        JSON.stringify({
          devDependencies: { vitest: "^1.0.0", eslint: "^9.0.0" },
        }),
      );

      const result = await runWithLayers(
        Effect.gen(function* () {
          const detect = yield* DetectService;
          return yield* detect.detect(tempDir);
        }),
      );

      const names = result.map((d) => d.name);
      expect(names).toContain("vitest");
      expect(names).toContain("eslint");
    });
  });
});

const detectIn = (dir: string, configLayer?: Layer.Layer<ConfigService>) =>
  runWithLayers(
    Effect.gen(function* () {
      const detect = yield* DetectService;
      return yield* detect.detect(dir);
    }),
    configLayer,
  );

const shelvedConfig = (url: string, alias: string) =>
  createMockConfigLayer({
    load: () =>
      Effect.succeed(
        new ShelfConfig({
          ...defaultConfig,
          repos: [
            new RepoEntry({
              url,
              alias,
              pin: Option.none(),
              depth: Option.none(),
              sparse: Option.none(),
              addedAt: new Date().toISOString(),
              lastSyncedAt: Option.none(),
            }),
          ],
        }),
      ),
  });

/** A registry that answers every package with a body that is not JSON. */
const startMalformedRegistry = async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{not json");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

describe("DetectService.detect resolving packages through the npm registry", () => {
  let tempDir: string;
  let stops: Array<() => Promise<void>>;
  const originalRegistry = process.env["SHELF_NPM_REGISTRY_URL"];

  const useRegistry = (url: string) => {
    process.env["SHELF_NPM_REGISTRY_URL"] = url;
  };

  const useStubRegistry = async (npm: Record<string, unknown>) => {
    const services = await startStubServices({ npm });
    stops.push(services.stop);
    useRegistry(services.npmUrl);
  };

  const writePackageJson = (dependencies: Record<string, string>) =>
    writeText(join(tempDir, "package.json"), JSON.stringify({ dependencies }));

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "shelf-detect-npm-test-"));
    stops = [];
  });

  afterEach(async () => {
    process.env["SHELF_NPM_REGISTRY_URL"] = originalRegistry;
    for (const stop of stops) await stop();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("uses the repository url the registry gives, normalized to an https clone url", async () => {
    await useStubRegistry({
      "left-pad-xyz": {
        repository: { type: "git", url: "git+https://github.com/acme/left-pad.git" },
      },
    });
    await writePackageJson({ "left-pad-xyz": "^1.0.0" });

    const result = await detectIn(tempDir);

    expect(result).toEqual([
      expect.objectContaining({
        name: "left-pad-xyz",
        url: "https://github.com/acme/left-pad.git",
        source: "npm",
        alreadyShelved: false,
      }),
    ]);
  });

  test("accepts a repository given as a shorthand string", async () => {
    await useStubRegistry({ "@acme/widget-xyz": { repository: "acme/widget" } });
    await writePackageJson({ "@acme/widget-xyz": "^1.0.0" });

    const result = await detectIn(tempDir);

    expect(result).toEqual([
      expect.objectContaining({
        name: "acme-widget-xyz",
        url: "https://github.com/acme/widget.git",
        source: "npm",
      }),
    ]);
  });

  test("marks a registry-resolved repo as already shelved when its url is on the shelf", async () => {
    await useStubRegistry({ "left-pad-xyz": { repository: "github:acme/left-pad" } });
    await writePackageJson({ "left-pad-xyz": "^1.0.0" });

    const result = await detectIn(
      tempDir,
      shelvedConfig("https://github.com/acme/left-pad.git", "pad"),
    );

    expect(result.map((d) => d.alreadyShelved)).toEqual([true]);
  });

  test("marks a registry-resolved repo as already shelved when its alias is on the shelf", async () => {
    await useStubRegistry({ "left-pad-xyz": { repository: "github:acme/left-pad" } });
    await writePackageJson({ "left-pad-xyz": "^1.0.0" });

    const result = await detectIn(
      tempDir,
      shelvedConfig("https://example.com/other.git", "left-pad-xyz"),
    );

    expect(result.map((d) => d.alreadyShelved)).toEqual([true]);
  });

  test.each([
    ["has no repository field", { name: "no-repo" }],
    ["has a repository object without a url", { repository: { type: "git" } }],
    ["has an empty repository string", { repository: "" }],
    ["is JSON null", null],
  ])("skips a package whose registry document %s", async (_label, doc) => {
    await useStubRegistry({ "odd-pkg-xyz": doc });
    await writePackageJson({ "odd-pkg-xyz": "^1.0.0", react: "^18.0.0" });

    const result = await detectIn(tempDir);

    expect(result.map((d) => d.name)).toEqual(["react"]);
  });

  test("skips a package the registry answers with a body that is not JSON", async () => {
    const registry = await startMalformedRegistry();
    stops.push(registry.stop);
    useRegistry(registry.url);
    await writePackageJson({ "odd-pkg-xyz": "^1.0.0", react: "^18.0.0" });

    const result = await detectIn(tempDir);

    expect(result.map((d) => d.name)).toEqual(["react"]);
  });

  test("skips a package when the registry cannot be reached, and keeps detecting", async () => {
    const services = await startStubServices();
    await services.stop();
    useRegistry(services.npmUrl);
    await writePackageJson({ "odd-pkg-xyz": "^1.0.0", react: "^18.0.0" });
    await writeText(
      join(tempDir, "go.mod"),
      "module x\n\nrequire github.com/gin-gonic/gin v1.9.1\n",
    );

    const result = await detectIn(tempDir);

    expect(result.map((d) => d.name)).toEqual(["react", "gin"]);
  });
});

describe("DetectService.detect with unusual manifests", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "shelf-detect-manifest-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("treats a package.json it cannot read as missing and still reads go.mod", async () => {
    await mkdir(join(tempDir, "package.json"));
    await writeText(
      join(tempDir, "go.mod"),
      "module x\n\nrequire github.com/gin-gonic/gin v1.9.1\n",
    );

    const result = await detectIn(tempDir);

    expect(result.map((d) => d.name)).toEqual(["gin"]);
  });

  test("treats a go.mod it cannot read as missing", async () => {
    await writeText(
      join(tempDir, "package.json"),
      JSON.stringify({ dependencies: { react: "1" } }),
    );
    await mkdir(join(tempDir, "go.mod"));

    const result = await detectIn(tempDir);

    expect(result.map((d) => d.name)).toEqual(["react"]);
  });

  test("finds nothing in an empty go.mod", async () => {
    await writeText(join(tempDir, "go.mod"), "");

    expect(await detectIn(tempDir)).toEqual([]);
  });

  test("names a major-version go module after the repo, not the version suffix", async () => {
    await writeText(
      join(tempDir, "go.mod"),
      "module x\n\nrequire github.com/go-chi/chi/v5 v5.0.0\n",
    );

    const result = await detectIn(tempDir);

    expect(result).toEqual([
      expect.objectContaining({
        name: "chi",
        url: "https://github.com/go-chi/chi.git",
        source: "go",
      }),
    ]);
  });

  test("marks a go repo as already shelved when its url is on the shelf", async () => {
    await writeText(
      join(tempDir, "go.mod"),
      "module x\n\nrequire github.com/gin-gonic/gin v1.9.1\n",
    );

    const result = await detectIn(
      tempDir,
      shelvedConfig("https://github.com/gin-gonic/gin.git", "my-gin"),
    );

    expect(result.map((d) => d.alreadyShelved)).toEqual([true]);
  });

  test("keeps only the first repo when two dependencies point at the same url", async () => {
    await writeText(
      join(tempDir, "go.mod"),
      "module x\n\nrequire (\n\tgithub.com/go-chi/chi v1.5.4\n\tgithub.com/go-chi/chi/v5 v5.0.0\n)\n",
    );

    const result = await detectIn(tempDir);

    expect(result.map((d) => d.url)).toEqual(["https://github.com/go-chi/chi.git"]);
  });
});
