import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import { ResolvedRepo } from "./resolve-schema";
import { ResolveError } from "./resolve-errors";
import { githubApiBaseUrl, resolveLocally } from "./resolve-utils";

const resolveViaGitHubApi = Effect.fn("resolveViaGitHubApi")(function* (name: string) {
	const response = yield* Effect.tryPromise({
		try: () =>
			fetch(
				`${githubApiBaseUrl(process.env)}/search/repositories?q=${encodeURIComponent(name)}&sort=stars&per_page=1`,
				{ headers: { Accept: "application/vnd.github.v3+json" } },
			),
		catch: () => new ResolveError({ input: name, message: "Failed to reach GitHub API" }),
	});

	if (!response.ok) {
		return yield* Effect.fail(
			new ResolveError({
				input: name,
				message: `GitHub API returned ${response.status}. Try: shelf add owner/repo or shelf add <full-url>`,
			}),
		);
	}

	const data = yield* Effect.tryPromise({
		try: () => response.json() as Promise<{ items: Array<{ clone_url: string; name: string }> }>,
		catch: () => new ResolveError({ input: name, message: "Failed to parse GitHub API response" }),
	});

	const firstItem = data.items?.at(0);
	if (!firstItem) {
		return yield* Effect.fail(
			new ResolveError({
				input: name,
				message: `No repositories found for "${name}". Try: shelf add owner/repo or shelf add <full-url>`,
			}),
		);
	}

	return new ResolvedRepo({
		url: firstItem.clone_url,
		suggestedAlias: name,
		source: "github-api",
	});
});

export class ResolveService extends Context.Service<ResolveService>()(
	"shelf/domain/resolve/ResolveService",
	{
		make: Effect.gen(function* () {
			return {
				resolve: Effect.fn("ResolveService.resolve")(function* (input: string) {
					const local = resolveLocally(input);
					if (local._tag === "Invalid") {
						return yield* Effect.fail(new ResolveError({ input, message: local.message }));
					}
					if (local._tag === "Search") {
						return yield* resolveViaGitHubApi(local.name);
					}
					return new ResolvedRepo({
						url: local.url,
						suggestedAlias: local.suggestedAlias,
						source: local.source,
					});
				}),
			};
		}),
	},
) {
	static layer = Layer.effect(this, this.make);
}
