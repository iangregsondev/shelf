import * as Schema from "effect/Schema";

const ResolveSource = Schema.Union([
  Schema.Literal("direct"),
  Schema.Literal("owner-repo"),
  Schema.Literal("prefixed"),
  Schema.Literal("registry"),
  Schema.Literal("github-api"),
]);

/** The part of a GitHub repository search response that resolve reads. `items` may be absent. */
export const GitHubSearchResponse = Schema.Struct({
  items: Schema.optionalKey(Schema.Array(Schema.Struct({ clone_url: Schema.String }))),
});

export const decodeGitHubSearchResponse = Schema.decodeUnknownEffect(GitHubSearchResponse);

export class ResolvedRepo extends Schema.Class<ResolvedRepo>("ResolvedRepo")({
  url: Schema.String,
  suggestedAlias: Schema.String,
  source: ResolveSource,
}) {}
