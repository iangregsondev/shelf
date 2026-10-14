export const stripSemverRange = (version: string): string => version.replace(/^[~^>=<]+/, "");

// Tags auto-pin tries, most specific first: a monorepo tags each package
// (`@scope/name@1.2.3` or `name@1.2.3`), so those beat a repo-wide `v1.2.3`.
const candidateTags = (packageName: string, version: string): string[] => {
  const bare = stripSemverRange(version);
  const shortName = packageName.split("/").pop() ?? packageName;
  const named =
    shortName === packageName
      ? [`${packageName}@${bare}`]
      : [`${packageName}@${bare}`, `${shortName}@${bare}`];
  return [...named, `v${bare}`, bare];
};

export const parseRemoteTags = (lsRemoteOutput: string): Set<string> => {
  const tags = new Set<string>();
  for (const line of lsRemoteOutput.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("\t");
    if (parts.length < 2) continue;
    let ref = parts[1] ?? "";
    if (!ref.startsWith("refs/tags/")) continue;
    ref = ref.replace("refs/tags/", "");
    if (ref.endsWith("^{}")) {
      ref = ref.slice(0, -3);
    }
    tags.add(ref);
  }
  return tags;
};

export const findMatchingTag = (
  packageName: string,
  version: string,
  remoteTags: Set<string>,
): string | null => {
  const candidates = candidateTags(packageName, version);
  for (const candidate of candidates) {
    if (remoteTags.has(candidate)) {
      return candidate;
    }
  }
  return null;
};
