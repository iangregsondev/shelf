import { describe, expect, test } from "bun:test";
import { resolveShelfHome } from "../../../src/domain/config/config-utils";

describe("resolveShelfHome", () => {
	const cases: ReadonlyArray<{
		name: string;
		env: Record<string, string | undefined>;
		cwd: string;
		expected: string;
	}> = [
		{
			name: "defaults to ~/.agents/shelf",
			env: {},
			cwd: "/work",
			expected: "/home/u/.agents/shelf",
		},
		{
			name: "uses an absolute SHELF_HOME as given",
			env: { SHELF_HOME: "/tmp/my-shelf" },
			cwd: "/work",
			expected: "/tmp/my-shelf",
		},
		{
			name: "resolves a relative SHELF_HOME against the working directory",
			env: { SHELF_HOME: "caches/shelf" },
			cwd: "/work",
			expected: "/work/caches/shelf",
		},
		{
			name: "ignores an empty SHELF_HOME",
			env: { SHELF_HOME: "" },
			cwd: "/work",
			expected: "/home/u/.agents/shelf",
		},
		{
			name: "drops a trailing slash",
			env: { SHELF_HOME: "/tmp/my-shelf/" },
			cwd: "/work",
			expected: "/tmp/my-shelf",
		},
	];

	for (const c of cases) {
		test(c.name, () => {
			expect(resolveShelfHome(c.env, "/home/u", c.cwd)).toBe(c.expected);
		});
	}
});
