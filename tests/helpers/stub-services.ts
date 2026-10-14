// A local HTTP server that stands in for the npm registry and the GitHub API,
// so tests never touch the network. Point shelf at it with
// SHELF_NPM_REGISTRY_URL and SHELF_GITHUB_API_URL.

export interface GitHubSearchItem {
	readonly clone_url: string;
	readonly name: string;
}

export interface StubResponses {
	/** npm package name → the JSON document the registry returns for it. Unknown names get 404. */
	readonly npm?: Readonly<Record<string, unknown>>;
	/** GitHub search query → the repos it finds. Unknown queries find nothing. */
	readonly github?: Readonly<Record<string, ReadonlyArray<GitHubSearchItem>>>;
}

export interface StubServices {
	readonly npmUrl: string;
	readonly githubUrl: string;
	readonly stop: () => Promise<void>;
}

export const startStubServices = (stubs: StubResponses = {}): StubServices => {
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(request) {
			const url = new URL(request.url);
			if (url.pathname.startsWith("/npm/")) {
				const name = decodeURIComponent(url.pathname.slice("/npm/".length));
				const doc = stubs.npm && Object.hasOwn(stubs.npm, name) ? stubs.npm[name] : undefined;
				return doc === undefined
					? Response.json({ error: "Not found" }, { status: 404 })
					: Response.json(doc);
			}
			if (url.pathname === "/github/search/repositories") {
				const query = url.searchParams.get("q") ?? "";
				const items = stubs.github && Object.hasOwn(stubs.github, query) ? stubs.github[query] : [];
				return Response.json({ total_count: items?.length ?? 0, items: items ?? [] });
			}
			return new Response("Not found", { status: 404 });
		},
	});
	const base = `http://127.0.0.1:${server.port}`;
	return {
		npmUrl: `${base}/npm`,
		githubUrl: `${base}/github`,
		stop: () => server.stop(true),
	};
};
