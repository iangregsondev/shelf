// referencesOf: who references each repo, from the registry's reference scan.

import { describe, test, expect, vi, afterEach } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { referencesOf } from "../../src/cli/references";
import { ShelfRegistry } from "../../src/domain/registry/registry-schema";
import type { ReferenceScan } from "../../src/domain/registry/registry-service";
import { createMockRegistryLayer } from "../domain/registry/helpers";

const lookup = (scan: Partial<ReferenceScan>, manual: ReadonlyArray<string> = []) =>
  Effect.runPromise(
    referencesOf().pipe(
      Effect.provide(
        createMockRegistryLayer({
          load: () => Effect.succeed(new ShelfRegistry({ projects: [], manual })),
          scanReferences: () =>
            Effect.succeed({
              aliases: new Set<string>(),
              projectsByAlias: new Map(),
              anyMightBeReferenced: false,
              staleProjects: [],
              warnings: [],
              ...scan,
            }),
        }),
      ),
    ),
  );

afterEach(() => {
  vi.restoreAllMocks();
});

describe("referencesOf", () => {
  test("lists manual first, then the projects that name the alias", async () => {
    const references = await lookup({ projectsByAlias: new Map([["lib", ["/a", "/b"]]]) }, [
      "lib",
      "other",
    ]);
    expect(references("lib")).toEqual(["manual", "/a", "/b"]);
    expect(references("other")).toEqual(["manual"]);
  });

  test("an alias nothing references gets an empty list", async () => {
    const references = await lookup({});
    expect(references("lib")).toEqual([]);
  });

  test("an unreferenced alias is unknown when some project couldn't be checked", async () => {
    const references = await lookup({
      anyMightBeReferenced: true,
      projectsByAlias: new Map([["named", ["/a"]]]),
    });
    expect(references("lib")).toBeNull();
    expect(references("named")).toEqual(["/a"]);
  });

  test("prints each scan warning to stderr", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await lookup({ warnings: ["first", "second"] });
    expect(error.mock.calls).toEqual([["Warning: first"], ["Warning: second"]]);
  });
});
