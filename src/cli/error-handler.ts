const errorMessages: Record<string, (error: Record<string, unknown>) => string> = {
  RepoNotFoundError: (e) =>
    `Repo "${String(e["alias"])}" not found. Run \`shelf list\` to see available repos.`,
  RepoAlreadyExistsError: (e) => `Repo "${String(e["alias"])}" already exists.`,
  InvalidAliasError: (e) => `Invalid alias "${String(e["alias"])}": ${String(e["message"])}.`,
  AliasRenameError: (e) =>
    `Could not rename "${String(e["from"])}" to "${String(e["to"])}": ${String(e["message"])}. Nothing was changed.`,
  GitOperationError: (e) => `Git error: ${String(e["message"])}`,
  SyncFailedError: (e) =>
    `Sync failed: ${String(e["failed"])} of ${String(e["total"])} repos could not be synced.`,
  AutoPinResolutionError: (e) => `Auto-pin failed: ${String(e["message"])}`,
  PinResolutionError: (e) => `Pin failed: ${String(e["message"])}`,
  ConfigParseError: (e) => `Config error: ${String(e["message"])}`,
  ConfigWriteError: (e) => `Could not save shelf state: ${String(e["message"])}`,
  RepoFolderError: (e) =>
    `Could not create the repo folder ${String(e["path"])}: ${String(e["message"])}`,
  InvalidConfigValueError: (e) => String(e["message"]),
  UnknownConfigKeyError: (e) =>
    `Unknown config key "${String(e["key"])}". Known keys: syncIntervalMinutes, version.`,
  InstallFailedError: (e) =>
    `Install failed: ${String(e["failed"])} of ${String(e["total"])} repos could not be added.`,
  ConfigNotFoundError: (e) => `Config not found: ${String(e["path"])}`,
  ShelffileNotFoundError: (e) =>
    `No shelffile found at ${String(e["path"])}. Create one or use \`shelf share\` to generate one.`,
  ShelffileParseError: (e) => `Shelffile error: ${String(e["message"])}`,
  RegistryParseError: (e) => `Registry error: ${String(e["message"])}`,
  RegistryWriteError: (e) => `Could not save the registry: ${String(e["message"])}`,
  ResolveError: (e) => `Could not resolve "${String(e["input"])}": ${String(e["message"])}`,
  DetectError: (e) => `Detection failed: ${String(e["message"])}`,
  UnknownAgentError: (e) =>
    `Unknown agent "${String(e["agent"])}". Expected one of: ${(e["known"] as ReadonlyArray<string>).join(", ")}`,
  DaemonAlreadyRunningError: (e) => `Daemon is already running (PID: ${String(e["pid"])}).`,
  DaemonNotRunningError: () => `No daemon is currently running.`,
  DaemonStartError: (e) => `Failed to start daemon: ${String(e["message"])}`,
  DaemonStillStoppingError: (e) =>
    `The daemon (PID: ${String(e["pid"])}) is still finishing its current step; it stops once that step is done. Run \`shelf daemon status\` to check.`,
};

export const formatUserError = (error: unknown): string | null => {
  if (error !== null && typeof error === "object" && "_tag" in error) {
    const tagged = error as Record<string, unknown>;
    const tag = String(tagged["_tag"]);
    // Own keys only: a tag like "toString" must not pick up Object.prototype methods.
    const formatter = Object.hasOwn(errorMessages, tag) ? errorMessages[tag] : undefined;
    if (formatter) {
      return formatter(tagged);
    }
  }
  return null;
};
