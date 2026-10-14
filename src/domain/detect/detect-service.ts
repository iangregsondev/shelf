import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Context from "effect/Context";
import { FileSystem } from "effect/FileSystem";
import { join } from "node:path";
import { ConfigService } from "../config/config-service";
import { lookupBuiltin } from "../resolve/resolve-utils";
import { deriveAlias } from "../repo/repo-utils";
import { DetectedRepo } from "./detect-schema";
import {
	parsePackageJson,
	parseGoMod,
	normalizeGitUrl,
	resolveGoModule,
	npmRegistryBaseUrl,
} from "./detect-utils";

const readFileOrNone = (fs: FileSystem, path: string): Effect.Effect<Option.Option<string>> =>
	Effect.gen(function* () {
		if (!(yield* fs.exists(path))) return Option.none<string>();
		return Option.some(yield* fs.readFileString(path));
	}).pipe(Effect.catch(() => Effect.succeed(Option.none<string>())));

const resolveNpmPackage = (name: string): Effect.Effect<Option.Option<string>> =>
	Effect.gen(function* () {
		const response = yield* Effect.tryPromise({
			try: () => fetch(`${npmRegistryBaseUrl(process.env)}/${encodeURIComponent(name)}`),
			catch: () => "fetch-failed" as const,
		}).pipe(Effect.catch(() => Effect.succeed(null)));

		if (!response || !response.ok) return Option.none();

		const data = yield* Effect.tryPromise({
			try: () =>
				response.json() as Promise<{
					repository?: { type?: string; url?: string } | string;
				}>,
			catch: () => "parse-failed" as const,
		}).pipe(Effect.catch(() => Effect.succeed(null)));

		if (!data) return Option.none();

		const repoField = data.repository;
		if (!repoField) return Option.none();

		const repoUrl = typeof repoField === "string" ? repoField : repoField.url;
		if (!repoUrl) return Option.none();

		return Option.some(normalizeGitUrl(repoUrl));
	});

export class DetectService extends Context.Service<DetectService>()(
	"shelf/domain/detect/DetectService",
	{
		make: Effect.gen(function* () {
			const fs = yield* FileSystem;
			const config = yield* ConfigService;

			return {
				detect: Effect.fn("DetectService.detect")(function* (dir: string) {
					const cfg = yield* config.load();
					const shelvedAliases = new Set(cfg.repos.map((r) => r.alias));
					const shelvedUrls = new Set(cfg.repos.map((r) => r.url));

					const detected: DetectedRepo[] = [];

					// Try package.json
					const pkgJsonPath = join(dir, "package.json");
					const pkgContent = yield* readFileOrNone(fs, pkgJsonPath);
					if (Option.isSome(pkgContent)) {
						const deps = parsePackageJson(pkgContent.value);
						for (const dep of deps) {
							// `@scope/name` can't be a folder name; the alias is `scope-name`.
							const alias = deriveAlias(dep.name);
							const registryUrl = lookupBuiltin(dep.name);
							if (registryUrl) {
								detected.push(
									new DetectedRepo({
										name: alias,
										url: registryUrl,
										source: "npm",
										alreadyShelved: shelvedAliases.has(alias) || shelvedUrls.has(registryUrl),
									}),
								);
								continue;
							}
							const npmUrl = yield* resolveNpmPackage(dep.name);
							if (Option.isSome(npmUrl)) {
								detected.push(
									new DetectedRepo({
										name: alias,
										url: npmUrl.value,
										source: "npm",
										alreadyShelved: shelvedAliases.has(alias) || shelvedUrls.has(npmUrl.value),
									}),
								);
							}
						}
					}

					// Try go.mod
					const goModPath = join(dir, "go.mod");
					const goContent = yield* readFileOrNone(fs, goModPath);
					if (Option.isSome(goContent)) {
						const deps = parseGoMod(goContent.value);
						for (const dep of deps) {
							const goUrl = resolveGoModule(dep.name);
							if (Option.isSome(goUrl)) {
								// `.../chi/v5` is named `chi`, not `v5`.
								const alias = deriveAlias(dep.name);
								detected.push(
									new DetectedRepo({
										name: alias,
										url: goUrl.value,
										source: "go",
										alreadyShelved: shelvedAliases.has(alias) || shelvedUrls.has(goUrl.value),
									}),
								);
							}
						}
					}

					// Deduplicate by URL
					const seen = new Set<string>();
					return detected.filter((d) => {
						if (seen.has(d.url)) return false;
						seen.add(d.url);
						return true;
					});
				}),
			};
		}),
	},
) {
	static layer = Layer.effect(this, this.make);
}
