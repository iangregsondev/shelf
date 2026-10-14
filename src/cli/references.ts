import * as Effect from "effect/Effect";
import * as Console from "effect/Console";
import { RegistryService } from "../domain/registry/registry-service";

/**
 * Scans which repos are referenced, prints the scan's warnings to stderr, and
 * returns a lookup for one alias: "manual" and the projects whose shelffile
 * names it; an empty list when nothing does; or null when shelf can't tell,
 * because some project couldn't be checked (see the warnings).
 */
export const referencesOf = Effect.fn("referencesOf")(function* () {
  const registry = yield* RegistryService;
  const scan = yield* registry.scanReferences();
  for (const warning of scan.warnings) {
    yield* Console.error(`Warning: ${warning}`);
  }
  const reg = yield* registry.load();
  const manual = new Set(reg.manual);
  return (alias: string): ReadonlyArray<string> | null => {
    const refs = [
      ...(manual.has(alias) ? ["manual"] : []),
      ...(scan.projectsByAlias.get(alias) ?? []),
    ];
    if (refs.length > 0) return refs;
    return scan.anyMightBeReferenced ? null : [];
  };
});
