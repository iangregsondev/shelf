import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Context from "effect/Context";
import type { RepoPin } from "../config/config-schema";
import { GitOperationError } from "./git-errors";
import { parseSymrefHead, runGit } from "./git-utils";

// Every git call puts `--` before URLs, refspecs and paths, so input that
// starts with `-` is never read as an option.
export class GitService extends Context.Service<GitService>()("shelf/domain/git/GitService", {
	make: Effect.gen(function* () {
		return {
			clone: Effect.fn("GitService.clone")(function* (
				url: string,
				targetDir: string,
				pin: Option.Option<RepoPin>,
				depth: Option.Option<number>,
				sparse: Option.Option<ReadonlyArray<string>>,
			) {
				const args = ["clone"];
				const isCommitPin = Option.isSome(pin) && pin.value.type === "commit";
				// Default to depth 1 — repos are for code reference, not history
				// Skip shallow clone for commit pins since the target commit may not be the tip
				if (Option.isSome(depth)) {
					args.push("--depth", String(depth.value));
				} else if (!isCommitPin) {
					args.push("--depth", "1");
				}
				if (Option.isSome(pin)) {
					const pinType = pin.value.type;
					if (pinType === "branch" || pinType === "tag") {
						args.push("--branch", pin.value.value);
					}
				}
				if (!isCommitPin) {
					args.push("--single-branch");
				}
				if (Option.isSome(sparse)) {
					args.push("--no-checkout");
				}
				args.push("--", url, targetDir);
				yield* runGit(args);
				if (Option.isSome(sparse)) {
					yield* runGit(["sparse-checkout", "init", "--cone"], targetDir);
					yield* runGit(["sparse-checkout", "set", "--", ...sparse.value], targetDir);
					yield* runGit(["checkout"], targetDir);
				}
				if (Option.isSome(pin) && pin.value.type === "commit") {
					yield* runGit(["checkout", "--detach", pin.value.value, "--"], targetDir);
				}
			}),

			/**
			 * Fetches one refspec from `origin`. With a depth the fetch is shallow;
			 * without one it never makes the clone shallower.
			 */
			fetch: Effect.fn("GitService.fetch")(function* (
				repoDir: string,
				refspec: string,
				depth: Option.Option<number>,
			) {
				const args = ["fetch", "--no-tags"];
				if (Option.isSome(depth)) {
					args.push("--depth", String(depth.value));
				}
				args.push("--", "origin", refspec);
				yield* runGit(args, repoDir);
			}),

			/** Whether `rev` names a commit already in the local clone. */
			hasCommit: Effect.fn("GitService.hasCommit")(function* (repoDir: string, rev: string) {
				return yield* runGit(
					["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`],
					repoDir,
				).pipe(
					Effect.as(true),
					Effect.catchTag("GitOperationError", () => Effect.succeed(false)),
				);
			}),

			/** Checks out `ref` as a detached HEAD. */
			checkout: Effect.fn("GitService.checkout")(function* (repoDir: string, ref: string) {
				yield* runGit(["checkout", "--detach", ref, "--"], repoDir);
			}),

			/** The branch `origin`'s HEAD points at, asked of the remote itself. */
			getDefaultBranch: Effect.fn("GitService.getDefaultBranch")(function* (repoDir: string) {
				const output = yield* runGit(["ls-remote", "--symref", "--", "origin", "HEAD"], repoDir);
				const branch = parseSymrefHead(output);
				if (branch === undefined) {
					return yield* new GitOperationError({
						command: "git ls-remote --symref -- origin HEAD",
						message: "the remote did not report a default branch",
					});
				}
				return branch;
			}),

			lsRemoteTags: Effect.fn("GitService.lsRemoteTags")(function* (url: string) {
				return yield* runGit(["ls-remote", "--tags", "--", url]);
			}),
		};
	}),
}) {
	static layer = Layer.effect(this, this.make);
}
