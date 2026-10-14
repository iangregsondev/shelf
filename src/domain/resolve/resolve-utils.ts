import { deriveAlias } from "../repo/repo-utils";

const OWNER_REPO_PATTERN = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
const PREFIXED_PATTERN = /^(github|gitlab|bitbucket):/;
const PATH_PATTERN = /^[./~]/;

export const expandOwnerRepo = (ownerRepo: string): string => `https://github.com/${ownerRepo}.git`;

export const expandPrefixed = (input: string): { host: string; ownerRepo: string; url: string } => {
	const colonIdx = input.indexOf(":");
	const prefix = input.slice(0, colonIdx);
	const ownerRepo = input.slice(colonIdx + 1);

	const hosts: Record<string, string> = {
		github: "github.com",
		gitlab: "gitlab.com",
		bitbucket: "bitbucket.org",
	};

	const host = hosts[prefix] ?? "github.com";
	return {
		host,
		ownerRepo,
		url: `https://${host}/${ownerRepo}.git`,
	};
};

export const deriveAliasFromOwnerRepo = (ownerRepo: string): string => {
	const parts = ownerRepo.split("/");
	const repo = parts.at(-1) ?? ownerRepo;
	return repo.replace(/\.git$/, "");
};

/**
 * Built-in registry mapping bare names to git URLs.
 * Covers popular libraries across JS/TS, Go, Rust, and Python ecosystems.
 */
export const builtinRegistry: Record<string, string> = {
	// --- JavaScript / TypeScript ---
	react: "https://github.com/facebook/react.git",
	next: "https://github.com/vercel/next.js.git",
	vue: "https://github.com/vuejs/core.git",
	nuxt: "https://github.com/nuxt/nuxt.git",
	svelte: "https://github.com/sveltejs/svelte.git",
	angular: "https://github.com/angular/angular.git",
	solid: "https://github.com/solidjs/solid.git",
	remix: "https://github.com/remix-run/remix.git",
	astro: "https://github.com/withastro/astro.git",
	gatsby: "https://github.com/gatsbyjs/gatsby.git",
	express: "https://github.com/expressjs/express.git",
	fastify: "https://github.com/fastify/fastify.git",
	hono: "https://github.com/honojs/hono.git",
	koa: "https://github.com/koajs/koa.git",
	nest: "https://github.com/nestjs/nest.git",
	effect: "https://github.com/Effect-TS/effect.git",
	zod: "https://github.com/colinhacks/zod.git",
	valibot: "https://github.com/fabian-hiller/valibot.git",
	typescript: "https://github.com/microsoft/TypeScript.git",
	bun: "https://github.com/oven-sh/bun.git",
	deno: "https://github.com/denoland/deno.git",
	node: "https://github.com/nodejs/node.git",
	vite: "https://github.com/vitejs/vite.git",
	webpack: "https://github.com/webpack/webpack.git",
	esbuild: "https://github.com/evanw/esbuild.git",
	rollup: "https://github.com/rollup/rollup.git",
	tailwindcss: "https://github.com/tailwindlabs/tailwindcss.git",
	prisma: "https://github.com/prisma/prisma.git",
	drizzle: "https://github.com/drizzle-team/drizzle-orm.git",
	trpc: "https://github.com/trpc/trpc.git",
	tanstack: "https://github.com/TanStack/query.git",
	zustand: "https://github.com/pmndrs/zustand.git",
	jotai: "https://github.com/pmndrs/jotai.git",
	redux: "https://github.com/reduxjs/redux.git",
	playwright: "https://github.com/microsoft/playwright.git",
	vitest: "https://github.com/vitest-dev/vitest.git",
	jest: "https://github.com/jestjs/jest.git",
	storybook: "https://github.com/storybookjs/storybook.git",
	eslint: "https://github.com/eslint/eslint.git",
	prettier: "https://github.com/prettier/prettier.git",
	biome: "https://github.com/biomejs/biome.git",
	three: "https://github.com/mrdoob/three.js.git",
	d3: "https://github.com/d3/d3.git",
	electron: "https://github.com/electron/electron.git",
	tauri: "https://github.com/tauri-apps/tauri.git",
	shadcn: "https://github.com/shadcn-ui/ui.git",
	radix: "https://github.com/radix-ui/primitives.git",
	"headless-ui": "https://github.com/tailwindlabs/headlessui.git",

	// --- Go ---
	gin: "https://github.com/gin-gonic/gin.git",
	echo: "https://github.com/labstack/echo.git",
	fiber: "https://github.com/gofiber/fiber.git",
	cobra: "https://github.com/spf13/cobra.git",
	viper: "https://github.com/spf13/viper.git",
	gorm: "https://github.com/go-gorm/gorm.git",
	chi: "https://github.com/go-chi/chi.git",
	zap: "https://github.com/uber-go/zap.git",
	logrus: "https://github.com/sirupsen/logrus.git",
	testify: "https://github.com/stretchr/testify.git",
	"go-kit": "https://github.com/go-kit/kit.git",
	gorilla: "https://github.com/gorilla/mux.git",
	"grpc-go": "https://github.com/grpc/grpc-go.git",
	hugo: "https://github.com/gohugoio/hugo.git",
	terraform: "https://github.com/hashicorp/terraform.git",

	// --- Rust ---
	tokio: "https://github.com/tokio-rs/tokio.git",
	axum: "https://github.com/tokio-rs/axum.git",
	actix: "https://github.com/actix/actix-web.git",
	serde: "https://github.com/serde-rs/serde.git",
	clap: "https://github.com/clap-rs/clap.git",
	anyhow: "https://github.com/dtolnay/anyhow.git",
	thiserror: "https://github.com/dtolnay/thiserror.git",
	reqwest: "https://github.com/seanmonstar/reqwest.git",
	diesel: "https://github.com/diesel-rs/diesel.git",
	sqlx: "https://github.com/launchbadge/sqlx.git",
	bevy: "https://github.com/bevyengine/bevy.git",
	wasm: "https://github.com/aspect-build/rules_wasm.git",
	rocket: "https://github.com/rwf2/Rocket.git",

	// --- Python ---
	fastapi: "https://github.com/fastapi/fastapi.git",
	django: "https://github.com/django/django.git",
	flask: "https://github.com/pallets/flask.git",
	pytorch: "https://github.com/pytorch/pytorch.git",
	tensorflow: "https://github.com/tensorflow/tensorflow.git",
	langchain: "https://github.com/langchain-ai/langchain.git",
	pandas: "https://github.com/pandas-dev/pandas.git",
	numpy: "https://github.com/numpy/numpy.git",
	pydantic: "https://github.com/pydantic/pydantic.git",
	sqlalchemy: "https://github.com/sqlalchemy/sqlalchemy.git",
	celery: "https://github.com/celery/celery.git",
	httpx: "https://github.com/encode/httpx.git",
	scrapy: "https://github.com/scrapy/scrapy.git",
	pytest: "https://github.com/pytest-dev/pytest.git",
	ruff: "https://github.com/astral-sh/ruff.git",

	// --- AI / ML ---
	transformers: "https://github.com/huggingface/transformers.git",
	"ollama-js": "https://github.com/ollama/ollama-js.git",
	"openai-node": "https://github.com/openai/openai-node.git",
	"openai-python": "https://github.com/openai/openai-python.git",
	"anthropic-sdk": "https://github.com/anthropics/anthropic-sdk-typescript.git",
};

/** The GitHub API base URL: `SHELF_GITHUB_API_URL` when set, otherwise the public API. */
export const githubApiBaseUrl = (env: Readonly<Record<string, string | undefined>>): string =>
	(env["SHELF_GITHUB_API_URL"] || "https://api.github.com").replace(/\/+$/, "");

/** The built-in registry's URL for a package name. Only the registry's own keys count, never names like `toString`. */
export const lookupBuiltin = (name: string): string | undefined =>
	Object.hasOwn(builtinRegistry, name) ? builtinRegistry[name] : undefined;

/** What resolving an input without the network gives. */
export type LocalResolution =
	| {
			readonly _tag: "Resolved";
			readonly url: string;
			readonly suggestedAlias: string;
			readonly source: "direct" | "owner-repo" | "prefixed" | "registry";
	  }
	| { readonly _tag: "Search"; readonly name: string }
	| { readonly _tag: "Invalid"; readonly message: string };

const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;
const SCP_PATTERN = /^[\w.-]+@[\w.-]+:/;

const URL_SCHEMES = new Set(["https", "http", "ssh", "git", "file", "git+ssh", "ssh+git"]);

const direct = (url: string): LocalResolution => ({
	_tag: "Resolved",
	url,
	suggestedAlias: deriveAlias(url),
	source: "direct",
});

const invalid = (input: string, problem: string): LocalResolution => ({
	_tag: "Invalid",
	message: `"${input}" ${problem}. Try: shelf add owner/repo or shelf add <full-url>`,
});

/** Drops trailing slashes and one `.git` suffix: `owner/repo.git/` → `owner/repo`. */
const trimRepoPath = (path: string): string => path.replace(/\/+$/, "").replace(/\.git$/, "");

const BROWSER_HOSTS = new Set(["github.com", "www.github.com", "gitlab.com", "bitbucket.org"]);

/**
 * Cuts a browser link down to the repo: drops a `#fragment` or `?query`, a
 * `/tree/...` or `/blob/...` path (GitLab's `/-/tree/...` too) and trailing slashes.
 */
export const stripBrowserPath = (url: string): string =>
	url
		.replace(/[#?].*$/, "")
		.replace(/\/(-\/)?(tree|blob)\/.*$/, "")
		.replace(/\/+$/, "");

const resolveSchemeUrl = (input: string): LocalResolution => {
	const scheme = input.slice(0, input.indexOf(":")).toLowerCase();
	if (!URL_SCHEMES.has(scheme)) return invalid(input, `uses an unsupported URL scheme "${scheme}"`);
	if (!URL.canParse(input)) return invalid(input, "is not a valid URL");
	const { pathname, hostname, protocol } = new URL(input);
	if (pathname.split("/").every((segment) => segment.length === 0)) {
		return invalid(input, "has no repository path");
	}
	const isBrowserLink = /^https?:$/.test(protocol) && BROWSER_HOSTS.has(hostname.toLowerCase());
	return direct(isBrowserLink ? stripBrowserPath(input) : input);
};

/**
 * Turns whatever a user typed (a URL, an scp-style SSH address, a path, a
 * shorthand or a package name) into a git remote, without the network.
 * Bare names not in the built-in registry come back as `Search`.
 */
export const resolveLocally = (raw: string): LocalResolution => {
	const input = raw.trim();
	if (SCHEME_PATTERN.test(input)) return resolveSchemeUrl(input);
	if (SCP_PATTERN.test(input)) return direct(input);
	if (PATH_PATTERN.test(input)) return direct(input);

	if (PREFIXED_PATTERN.test(input)) {
		const { url, ownerRepo } = expandPrefixed(trimRepoPath(input));
		return {
			_tag: "Resolved",
			url,
			suggestedAlias: deriveAliasFromOwnerRepo(ownerRepo),
			source: "prefixed",
		};
	}

	const segments = trimRepoPath(input).split("/");
	if (segments.length >= 3 && segments[0]?.includes(".")) {
		const resolved = resolveSchemeUrl(`https://${input}`);
		return resolved._tag === "Resolved" ? { ...resolved, source: "owner-repo" } : resolved;
	}

	const ownerRepo = trimRepoPath(input);
	if (OWNER_REPO_PATTERN.test(ownerRepo)) {
		return {
			_tag: "Resolved",
			url: expandOwnerRepo(ownerRepo),
			suggestedAlias: deriveAliasFromOwnerRepo(ownerRepo),
			source: "owner-repo",
		};
	}

	const registryUrl = lookupBuiltin(input);
	if (registryUrl !== undefined) {
		return { _tag: "Resolved", url: registryUrl, suggestedAlias: input, source: "registry" };
	}
	return { _tag: "Search", name: input };
};
