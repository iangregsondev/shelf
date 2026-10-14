import { join, resolve } from "node:path";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The shelf home: `SHELF_HOME` when set and non-empty (relative paths resolve
 * against `cwd`), otherwise `~/.agents/shelf`.
 */
export const resolveShelfHome = (env: Env, homeDir: string, cwd: string): string => {
	const override = env["SHELF_HOME"];
	if (override !== undefined && override !== "") {
		return resolve(cwd, override);
	}
	return join(homeDir, ".agents", "shelf");
};
