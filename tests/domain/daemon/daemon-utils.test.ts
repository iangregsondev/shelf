import { describe, expect, test } from "bun:test";
import {
	daemonStatePath,
	daemonLogPath,
	generateToken,
	daemonTokenFromArgs,
	isDaemonCommandLine,
} from "../../../src/domain/daemon/daemon-utils";

describe("daemonStatePath", () => {
	test("returns correct path", () => {
		expect(daemonStatePath("/home/user/.agents/shelf")).toBe(
			"/home/user/.agents/shelf/daemon.json",
		);
	});
});

describe("daemonLogPath", () => {
	test("returns correct path", () => {
		expect(daemonLogPath("/home/user/.agents/shelf")).toBe("/home/user/.agents/shelf/daemon.log");
	});
});

describe("generateToken", () => {
	test("returns a 32-character hex string", () => {
		const token = generateToken();
		expect(token).toMatch(/^[0-9a-f]{32}$/);
	});

	test("generates unique tokens", () => {
		const tokens = new Set(Array.from({ length: 10 }, () => generateToken()));
		expect(tokens.size).toBe(10);
	});
});

describe("daemonTokenFromArgs", () => {
	test("reads the value after --token", () => {
		expect(daemonTokenFromArgs(["bun", "/x/daemon.ts", "--token", "abc"])).toBe("abc");
	});

	test("is undefined without --token or without a value", () => {
		expect(daemonTokenFromArgs(["bun", "/x/daemon.ts"])).toBeUndefined();
		expect(daemonTokenFromArgs(["bun", "/x/daemon.ts", "--token"])).toBeUndefined();
	});
});

describe("isDaemonCommandLine", () => {
	const token = "0123456789abcdef0123456789abcdef";

	test("accepts the daemon entry point carrying the token", () => {
		expect(
			isDaemonCommandLine(
				`/usr/local/bin/bun /opt/shelf/src/startup/daemon.ts --token ${token}`,
				token,
			),
		).toBe(true);
	});

	test("rejects the daemon entry point with another token", () => {
		expect(
			isDaemonCommandLine(`bun /opt/shelf/src/startup/daemon.ts --token ${"f".repeat(32)}`, token),
		).toBe(false);
	});

	test("rejects a token that is only a prefix of the recorded one", () => {
		expect(isDaemonCommandLine(`bun /opt/daemon.ts --token ${token.slice(0, 16)}`, token)).toBe(
			false,
		);
	});

	test("rejects another program carrying the token", () => {
		expect(isDaemonCommandLine(`vim notes-daemon.ts.bak --token ${token}`, token)).toBe(false);
		expect(isDaemonCommandLine(`sleep 60 ${token}`, token)).toBe(false);
	});

	test("rejects an empty command line", () => {
		expect(isDaemonCommandLine("", token)).toBe(false);
	});
});
