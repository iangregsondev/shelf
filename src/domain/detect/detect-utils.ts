import * as Option from "effect/Option";
import { PackageDependency } from "./detect-schema";
import { stripBrowserPath } from "../resolve/resolve-utils";

export const parsePackageJson = (content: string): ReadonlyArray<PackageDependency> => {
  try {
    const pkg = JSON.parse(content) as Record<string, unknown>;
    const deps = (pkg["dependencies"] ?? {}) as Record<string, string>;
    const devDeps = (pkg["devDependencies"] ?? {}) as Record<string, string>;
    const all = { ...deps, ...devDeps };
    return Object.entries(all).map(
      ([name, version]) => new PackageDependency({ name, version, source: "npm" }),
    );
  } catch {
    return [];
  }
};

export const parseGoMod = (content: string): ReadonlyArray<PackageDependency> => {
  const deps: PackageDependency[] = [];
  const lines = content.split("\n");
  let inRequireBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === "require (") {
      inRequireBlock = true;
      continue;
    }
    if (trimmed === ")" && inRequireBlock) {
      inRequireBlock = false;
      continue;
    }

    if (inRequireBlock) {
      const match = trimmed.match(/^(\S+)\s+(\S+)/);
      const name = match?.at(1);
      const version = match?.at(2);
      if (name && version) {
        deps.push(new PackageDependency({ name, version, source: "go" }));
      }
    }

    const singleMatch = trimmed.match(/^require\s+(\S+)\s+(\S+)/);
    const singleName = singleMatch?.at(1);
    const singleVersion = singleMatch?.at(2);
    if (singleName && singleVersion) {
      deps.push(new PackageDependency({ name: singleName, version: singleVersion, source: "go" }));
    }
  }

  return deps;
};

const SHORTHAND_HOSTS: Readonly<Record<string, string>> = {
  github: "github.com",
  gitlab: "gitlab.com",
  bitbucket: "bitbucket.org",
};

/**
 * Turns a package manifest's repository field into an https clone URL.
 * Handles `git+` prefixes, `git://`, `ssh://git@` and `git@host:` forms,
 * `github:`/`gitlab:`/`bitbucket:` and bare `owner/repo` shorthands, and
 * browser links with a `#fragment`, `?query` or `/tree/...` path.
 */
export const normalizeGitUrl = (url: string): string => {
  let normalized = url
    .trim()
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^ssh:\/\/git@/, "https://")
    .replace(/^git@([^:/]+):/, "https://$1/");

  const shorthand = normalized.match(/^(github|gitlab|bitbucket):(.*)$/);
  if (shorthand) {
    normalized = `https://${SHORTHAND_HOSTS[shorthand[1] ?? "github"]}/${shorthand[2] ?? ""}`;
  } else if (/^[\w.-]+\/[\w.-]+\/?$/.test(normalized)) {
    normalized = `https://github.com/${normalized}`;
  }

  normalized = stripBrowserPath(normalized);

  if (!normalized.endsWith(".git")) {
    normalized = `${normalized}.git`;
  }

  return normalized;
};

export const resolveGoModule = (modulePath: string): Option.Option<string> => {
  if (modulePath.startsWith("github.com/")) {
    const parts = modulePath.split("/");
    if (parts.length >= 3) {
      return Option.some(`https://github.com/${parts[1]}/${parts[2]}.git`);
    }
  }
  return Option.none();
};

/** The npm registry base URL: `SHELF_NPM_REGISTRY_URL` when set, otherwise the public registry. */
export const npmRegistryBaseUrl = (env: Readonly<Record<string, string | undefined>>): string =>
  (env["SHELF_NPM_REGISTRY_URL"] || "https://registry.npmjs.org").replace(/\/+$/, "");
