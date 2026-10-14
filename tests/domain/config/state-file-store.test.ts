import { describe, test, expect } from "bun:test";
import { parseLockPid } from "../../../src/domain/config/state-file-store";

describe("parseLockPid", () => {
	test("reads the owner PID", () => {
		expect(parseLockPid("4242")).toBe(4242);
		expect(parseLockPid("4242\n")).toBe(4242);
	});

	test("gives undefined when the lock holds no PID yet or garbage", () => {
		expect(parseLockPid("")).toBeUndefined();
		expect(parseLockPid("0")).toBeUndefined();
		expect(parseLockPid("-1")).toBeUndefined();
		expect(parseLockPid("12abc")).toBeUndefined();
	});
});
