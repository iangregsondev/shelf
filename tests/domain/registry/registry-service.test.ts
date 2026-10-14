import { describe, test, expect, beforeEach, afterEach } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { mkdtemp, rm, mkdir, writeFile, readFile, symlink } from "node:fs/promises";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RegistryService } from "../../../src/domain/registry/registry-service";
import { ConfigService } from "../../../src/domain/config/config-service";
import { defaultConfig } from "../../../src/domain/config/config-schema";
import { ShelfRegistry } from "../../../src/domain/registry/registry-schema";
import { createMockShelffileLayer } from "../shelffile/helpers";
import {
  ShelffileNotFoundError,
  ShelffileParseError,
} from "../../../src/domain/shelffile/shelffile-errors";
import type { Shelffile } from "../../../src/domain/shelffile/shelffile-schema";
import type { ShelffileOverrides } from "../shelffile/helpers";
import { PlatformLayer } from "../../helpers/platform";

describe("RegistryService", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "shelf-registry-test-"));
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const buildLayer = (shelffileOverrides: ShelffileOverrides = {}) => {
    const configLayer = Layer.succeed(
      ConfigService,
      ConfigService.of({
        load: () => Effect.succeed(defaultConfig),
        update: (fn) => {
          const result = fn(defaultConfig);
          return Effect.isEffect(result) ? result : Effect.succeed(result);
        },
        updateRepo: () => Effect.succeed(Option.none()),
        ensureDirectories: () => Effect.void,
        repoPath: (alias: string) => Effect.succeed(join(tempDir, "repos", alias)),
        shelfHome: tempDir,
        reposDir: join(tempDir, "repos"),
        configPath: join(tempDir, "config.json"),
      }),
    );
    const shelffileLayer = createMockShelffileLayer(shelffileOverrides);
    return RegistryService.layer.pipe(
      Layer.provide(configLayer),
      Layer.provide(shelffileLayer),
      Layer.provide(PlatformLayer),
    );
  };

  test("load returns default when no file", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* RegistryService;
        return yield* svc.load();
      }).pipe(Effect.provide(buildLayer())),
    );
    expect(result.projects).toEqual([]);
    expect(result.manual).toEqual([]);
  });

  test("registerProject adds project path (deduped)", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* RegistryService;
        yield* svc.registerProject("/tmp/project-a");
        yield* svc.registerProject("/tmp/project-a"); // duplicate
        yield* svc.registerProject("/tmp/project-b");
        return yield* svc.load();
      }).pipe(Effect.provide(buildLayer())),
    );
    expect(result.projects).toEqual(["/tmp/project-a", "/tmp/project-b"]);
  });

  test("unregisterProject removes project path", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* RegistryService;
        yield* svc.registerProject("/tmp/project-a");
        yield* svc.registerProject("/tmp/project-b");
        yield* svc.unregisterProject("/tmp/project-a");
        return yield* svc.load();
      }).pipe(Effect.provide(buildLayer())),
    );
    expect(result.projects).toEqual(["/tmp/project-b"]);
  });

  test("addManual adds alias (deduped)", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* RegistryService;
        yield* svc.addManual("effect");
        yield* svc.addManual("effect"); // duplicate
        yield* svc.addManual("react");
        return yield* svc.load();
      }).pipe(Effect.provide(buildLayer())),
    );
    expect(result.manual).toEqual(["effect", "react"]);
  });

  test("removeManual removes alias", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* RegistryService;
        yield* svc.addManual("effect");
        yield* svc.addManual("react");
        yield* svc.removeManual("effect");
        return yield* svc.load();
      }).pipe(Effect.provide(buildLayer())),
    );
    expect(result.manual).toEqual(["react"]);
  });

  test("scanReferences returns union of shelffile aliases + manual", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "shelf-project-"));
    const shelffileData: Shelffile = {
      entries: [
        { alias: "lib-a", url: "https://github.com/test/lib-a.git", pin: Option.none() },
        { alias: "lib-b", url: "https://github.com/test/lib-b.git", pin: Option.none() },
      ],
    };
    const layer = buildLayer({
      read: (dir: string) => {
        if (dir === projectDir) return Effect.succeed(shelffileData);
        return Effect.fail(new ShelffileNotFoundError({ path: dir }));
      },
    });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* RegistryService;
        yield* svc.addManual("manual-repo");
        yield* svc.registerProject(projectDir);
        return (yield* svc.scanReferences()).aliases;
      }).pipe(Effect.provide(layer)),
    );
    expect(result.has("lib-a")).toBe(true);
    expect(result.has("lib-b")).toBe(true);
    expect(result.has("manual-repo")).toBe(true);
    await rm(projectDir, { recursive: true, force: true });
  });

  test("scanReferences gracefully handles missing shelffiles", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "shelf-project-"));
    const layer = buildLayer({
      read: () => Effect.fail(new ShelffileNotFoundError({ path: "test" })),
    });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* RegistryService;
        yield* svc.addManual("manual-repo");
        yield* svc.registerProject(projectDir);
        return (yield* svc.scanReferences()).aliases;
      }).pipe(Effect.provide(layer)),
    );
    expect(result.has("manual-repo")).toBe(true);
    expect(result.size).toBe(1);
    await rm(projectDir, { recursive: true, force: true });
  });

  test("scanReferences marks gone project folders stale, including a path under a file", async () => {
    const goneDir = join(tempDir, "gone");
    const underFile = join(tempDir, "a-file", "project");
    await writeFile(join(tempDir, "a-file"), "not a folder");
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* RegistryService;
        yield* svc.registerProject(goneDir);
        yield* svc.registerProject(underFile);
        return yield* svc.scanReferences();
      }).pipe(Effect.provide(buildLayer())),
    );
    expect(result.staleProjects).toEqual([goneDir, underFile]);
    expect(result.anyMightBeReferenced).toBe(false);
    expect(result.warnings).toEqual([]);
  });
});

describe("RegistryService edge cases", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "shelf-registry-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  const buildLayer = (shelffileOverrides: ShelffileOverrides = {}, shelfHome = tempDir) =>
    RegistryService.layer.pipe(
      Layer.provide(
        Layer.succeed(
          ConfigService,
          ConfigService.of({
            load: () => Effect.succeed(defaultConfig),
            update: (fn) => {
              const result = fn(defaultConfig);
              return Effect.isEffect(result) ? result : Effect.succeed(result);
            },
            updateRepo: () => Effect.succeed(Option.none()),
            ensureDirectories: () => Effect.void,
            repoPath: (alias: string) => Effect.succeed(join(shelfHome, "repos", alias)),
            shelfHome,
            reposDir: join(shelfHome, "repos"),
            configPath: join(shelfHome, "config.json"),
          }),
        ),
      ),
      Layer.provide(createMockShelffileLayer(shelffileOverrides)),
      Layer.provide(PlatformLayer),
    );

  const run = <A, E>(
    body: (svc: RegistryService["Service"]) => Effect.Effect<A, E>,
    layer = buildLayer(),
  ) =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* body(yield* RegistryService);
      }).pipe(Effect.provide(layer)),
    );

  const runFailure = <A, E>(
    body: (svc: RegistryService["Service"]) => Effect.Effect<A, E>,
    layer = buildLayer(),
  ) => run((svc) => Effect.flip(body(svc)), layer);

  const writeRegistry = (registry: unknown) =>
    writeFile(join(tempDir, "registry.json"), JSON.stringify(registry));

  const readRegistry = async () =>
    JSON.parse(await readFile(join(tempDir, "registry.json"), "utf8")) as {
      projects: string[];
      manual: string[];
    };

  describe("load", () => {
    test("reads a saved registry", async () => {
      await writeRegistry({ projects: ["/p"], manual: ["a"] });
      const registry = await run((svc) => svc.load());
      expect(registry.projects).toEqual(["/p"]);
      expect(registry.manual).toEqual(["a"]);
    });

    test("fails with RegistryParseError on a registry file that fails schema decoding", async () => {
      await writeRegistry({ projects: "not-an-array", manual: [] });
      const error = await runFailure((svc) => svc.load());
      expect(error._tag).toBe("RegistryParseError");
      expect(error.message).toBe("Invalid registry schema");
    });

    test("fails with RegistryParseError on a registry file that is not JSON", async () => {
      await writeFile(join(tempDir, "registry.json"), "{ not json");
      const error = await runFailure((svc) => svc.load());
      expect(error._tag).toBe("RegistryParseError");
      expect(error.message).toBe("Failed to read registry file");
    });

    test("fails with RegistryParseError when the registry path can't be read", async () => {
      await mkdir(join(tempDir, "registry.json"));
      const error = await runFailure((svc) => svc.load());
      expect(error._tag).toBe("RegistryParseError");
      expect(error.message).toBe("Failed to read registry file");
    });

    test("fails with RegistryParseError when the registry path can't be checked", async () => {
      await writeFile(join(tempDir, "a-file"), "not a folder");
      const error = await runFailure(
        (svc) => svc.load(),
        buildLayer({}, join(tempDir, "a-file", "home")),
      );
      expect(error._tag).toBe("RegistryParseError");
      expect(error.message).toBe("Failed to check registry file");
    });
  });

  describe("update", () => {
    test("saves and returns what the function makes of the current registry", async () => {
      await writeRegistry({ projects: [], manual: ["a"] });
      const saved = await run((svc) =>
        svc.update(
          (current) => new ShelfRegistry({ ...current, manual: [...current.manual, "b"] }),
        ),
      );
      expect(saved.manual).toEqual(["a", "b"]);
      expect(await readRegistry()).toEqual({ projects: [], manual: ["a", "b"] });
    });

    test("fails with RegistryWriteError when the registry file can't be written", async () => {
      await writeRegistry({ projects: [], manual: [] });
      const error = await runFailure((svc) =>
        svc.update((current) => {
          // Put a non-empty folder where the registry file goes, so the save can't replace it.
          rmSync(join(tempDir, "registry.json"));
          mkdirSync(join(tempDir, "registry.json", "inside"), { recursive: true });
          return current;
        }),
      );
      expect(error._tag).toBe("RegistryWriteError");
      expect(error.message).toBe("Failed to write registry file");
    });

    test("fails with RegistryWriteError when the registry lock can't be taken", async () => {
      await writeFile(join(tempDir, "a-file"), "not a folder");
      const error = await runFailure(
        (svc) => svc.addManual("a"),
        buildLayer({}, join(tempDir, "a-file", "home")),
      );
      expect(error._tag).toBe("RegistryWriteError");
      expect(error.message).toMatch(/^Failed to lock /);
    });

    test("fails with RegistryParseError and leaves the file alone when the registry is invalid", async () => {
      await writeRegistry({ projects: 1, manual: [] });
      const error = await runFailure((svc) => svc.addManual("a"));
      expect(error._tag).toBe("RegistryParseError");
      expect(await readRegistry()).toEqual({ projects: 1, manual: [] });
    });
  });

  describe("registerProject", () => {
    test("replaces an older relative entry for the same folder and keeps the others", async () => {
      const dir = resolve(process.cwd(), "some/project");
      await writeRegistry({ projects: ["some/project", "other/project", "/abs/one"], manual: [] });
      await run((svc) => svc.registerProject(dir));
      expect((await readRegistry()).projects).toEqual(["other/project", "/abs/one", dir]);
    });
  });

  describe("renameManual", () => {
    test("moves the old alias to the new name at the end of the list", async () => {
      await writeRegistry({ projects: [], manual: ["old", "keep"] });
      await run((svc) => svc.renameManual("old", "new"));
      expect((await readRegistry()).manual).toEqual(["keep", "new"]);
    });

    test("doesn't duplicate a new alias that is already listed", async () => {
      await writeRegistry({ projects: [], manual: ["new", "old", "keep"] });
      await run((svc) => svc.renameManual("old", "new"));
      expect((await readRegistry()).manual).toEqual(["keep", "new"]);
    });

    test("leaves the list alone when the old alias isn't listed", async () => {
      await writeRegistry({ projects: [], manual: ["keep"] });
      await run((svc) => svc.renameManual("missing", "new"));
      expect((await readRegistry()).manual).toEqual(["keep"]);
    });
  });

  describe("dropProjects", () => {
    test("removes only the given project folders", async () => {
      await writeRegistry({ projects: ["/a", "/b", "/c"], manual: ["m"] });
      await run((svc) => svc.dropProjects(["/a", "/c", "/not-listed"]));
      expect(await readRegistry()).toEqual({ projects: ["/b"], manual: ["m"] });
    });

    test("does nothing, not even read the registry, when given no folders", async () => {
      await writeRegistry({ projects: "broken", manual: [] });
      await run((svc) => svc.dropProjects([]));
      expect(await readRegistry()).toEqual({ projects: "broken", manual: [] });
    });
  });

  describe("scanReferences", () => {
    test("keeps every repo and warns about a relative entry from an older shelf", async () => {
      await writeRegistry({ projects: ["rel/project"], manual: ["m"] });
      const scan = await run((svc) => svc.scanReferences());
      expect([...scan.aliases]).toEqual(["m"]);
      expect(scan.anyMightBeReferenced).toBe(true);
      expect(scan.staleProjects).toEqual([]);
      expect(scan.warnings).toEqual([
        'Registry entry "rel/project" is a relative path from an older shelf and can\'t be located. Run `shelf install --dir rel/project` from the folder you first ran it in (or delete the entry from registry.json).',
      ]);
    });

    test("keeps every repo and warns when a project folder can't be checked", async () => {
      // A symlink to itself: stat fails with ELOOP, so the folder may still exist.
      const loop = join(tempDir, "loop");
      await symlink(loop, loop);
      await writeRegistry({ projects: [loop], manual: [] });
      const scan = await run((svc) => svc.scanReferences());
      expect(scan.anyMightBeReferenced).toBe(true);
      expect(scan.staleProjects).toEqual([]);
      expect(scan.warnings).toHaveLength(1);
      expect(scan.warnings[0]).toMatch(new RegExp(`^Can't check project ${loop}: .*ELOOP`));
    });

    test("keeps the aliases a shelffile that fails to parse still names, with a warning", async () => {
      const projectDir = join(tempDir, "project");
      await mkdir(projectDir);
      await writeRegistry({ projects: [projectDir], manual: [] });
      const layer = buildLayer({
        read: () => Effect.fail(new ShelffileParseError({ message: "bad line 3" })),
        possibleAliases: (dir) =>
          dir === projectDir
            ? Effect.succeed(new Set(["lib-a", "lib-b"]))
            : Effect.succeed(new Set()),
      });
      const scan = await run((svc) => svc.scanReferences(), layer);
      expect([...scan.aliases].sort()).toEqual(["lib-a", "lib-b"]);
      expect(scan.anyMightBeReferenced).toBe(false);
      expect(scan.warnings).toEqual([
        `Can't parse ${join(projectDir, "shelffile")} (bad line 3); keeping every repo it names.`,
      ]);
    });

    test("keeps every repo when a shelffile can't be parsed or read for aliases", async () => {
      const projectDir = join(tempDir, "project");
      await mkdir(projectDir);
      await writeRegistry({ projects: [projectDir], manual: ["m"] });
      const layer = buildLayer({
        read: () => Effect.fail(new ShelffileParseError({ message: "bad line 3" })),
        possibleAliases: () => Effect.fail(new ShelffileParseError({ message: "unreadable" })),
      });
      const scan = await run((svc) => svc.scanReferences(), layer);
      expect([...scan.aliases]).toEqual(["m"]);
      expect(scan.anyMightBeReferenced).toBe(true);
      expect(scan.warnings).toEqual([
        `Can't read ${join(projectDir, "shelffile")} (bad line 3); keeping every repo.`,
      ]);
    });

    test("fails with RegistryParseError when the registry is invalid", async () => {
      await writeRegistry({ projects: [], manual: "broken" });
      const error = await runFailure((svc) => svc.scanReferences());
      expect(error._tag).toBe("RegistryParseError");
    });
  });
});
