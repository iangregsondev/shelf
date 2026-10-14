// The installed shelf version, read from the package manifest so the CLI and
// the daemon never drift from what was published.
import manifest from "../package.json" with { type: "json" };

export const SHELF_VERSION: string = manifest.version;
