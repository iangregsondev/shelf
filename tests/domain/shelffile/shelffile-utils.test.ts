import { describe, test, expect } from "bun:test";
import * as Option from "effect/Option";
import { RepoPin } from "../../../src/domain/config/config-schema";
import {
	parseShelffile,
	serializeShelffile,
	parseShelffilePin,
	parseShelffileLine,
	possibleShelffileAliases,
} from "../../../src/domain/shelffile/shelffile-utils";
import { ShelffileParseError } from "../../../src/domain/shelffile/shelffile-errors";

describe("shelffile-utils", () => {
	describe("possibleShelffileAliases", () => {
		test("takes the first word of every line, even lines that don't parse", () => {
			const content = [
				"# a comment",
				"good https://github.com/a/good.git",
				"bad-pin https://github.com/a/b.git pin:nonsense",
				"",
				"  lonely   # only an alias",
				"bad/alias https://github.com/a/c.git",
			].join("\n");
			expect([...possibleShelffileAliases(content)]).toEqual([
				"good",
				"bad-pin",
				"lonely",
				"bad/alias",
			]);
		});
	});

	describe("parseShelffilePin", () => {
		test("parses branch pin", () => {
			const pin = parseShelffilePin("pin:branch:main");
			expect(pin.type).toBe("branch");
			expect(pin.value).toBe("main");
		});

		test("parses tag pin", () => {
			const pin = parseShelffilePin("pin:tag:v1.0.0");
			expect(pin.type).toBe("tag");
			expect(pin.value).toBe("v1.0.0");
		});

		test("parses commit pin (40-char hash)", () => {
			const hash = "abc123def456abc123def456abc123def456abc1";
			const pin = parseShelffilePin(`pin:${hash}`);
			expect(pin.type).toBe("commit");
			expect(pin.value).toBe(hash);
		});

		test("throws on missing pin: prefix", () => {
			expect(() => parseShelffilePin("branch:main")).toThrow(ShelffileParseError);
		});

		test("throws on invalid pin format", () => {
			expect(() => parseShelffilePin("pin:invalid")).toThrow(ShelffileParseError);
		});
	});

	describe("parseShelffileLine", () => {
		test("parses alias and url", () => {
			const entry = parseShelffileLine("effect https://github.com/Effect-TS/effect.git", 1);
			expect(entry.alias).toBe("effect");
			expect(entry.url).toBe("https://github.com/Effect-TS/effect.git");
			expect(Option.isNone(entry.pin)).toBe(true);
		});

		test("parses alias, url, and pin", () => {
			const entry = parseShelffileLine(
				"react https://github.com/facebook/react.git pin:tag:v19.0.0",
				1,
			);
			expect(entry.alias).toBe("react");
			expect(entry.url).toBe("https://github.com/facebook/react.git");
			expect(Option.isSome(entry.pin)).toBe(true);
			if (Option.isSome(entry.pin)) {
				expect(entry.pin.value.type).toBe("tag");
				expect(entry.pin.value.value).toBe("v19.0.0");
			}
		});

		test("throws on line with only alias", () => {
			expect(() => parseShelffileLine("effect", 1)).toThrow(ShelffileParseError);
		});
	});

	describe("parseShelffile", () => {
		test("parses valid shelffile", () => {
			const content = [
				"effect https://github.com/Effect-TS/effect.git pin:branch:main",
				"react https://github.com/facebook/react.git pin:tag:v19.0.0",
			].join("\n");
			const shelffile = parseShelffile(content);
			expect(shelffile.entries.length).toBe(2);
			expect(shelffile.entries[0]!.alias).toBe("effect");
			expect(shelffile.entries[1]!.alias).toBe("react");
		});

		test("ignores blank lines and comments", () => {
			const content = [
				"# This is a comment",
				"",
				"effect https://github.com/Effect-TS/effect.git",
				"",
				"# Another comment",
				"react https://github.com/facebook/react.git",
			].join("\n");
			const shelffile = parseShelffile(content);
			expect(shelffile.entries.length).toBe(2);
		});

		test("parses empty content", () => {
			const shelffile = parseShelffile("");
			expect(shelffile.entries.length).toBe(0);
		});

		test("parses entries without pins", () => {
			const content = "effect https://github.com/Effect-TS/effect.git\n";
			const shelffile = parseShelffile(content);
			expect(shelffile.entries.length).toBe(1);
			expect(Option.isNone(shelffile.entries[0]!.pin)).toBe(true);
		});

		test("throws on malformed line", () => {
			const content = "only-alias\n";
			expect(() => parseShelffile(content)).toThrow(ShelffileParseError);
		});
	});

	describe("serializeShelffile", () => {
		test("serializes entries without pins", () => {
			const shelffile = {
				entries: [
					{ alias: "effect", url: "https://github.com/Effect-TS/effect.git", pin: Option.none() },
				],
			};
			const result = serializeShelffile(shelffile);
			expect(result).toBe("effect https://github.com/Effect-TS/effect.git\n");
		});

		test("serializes entries with branch pin", () => {
			const shelffile = {
				entries: [
					{
						alias: "effect",
						url: "https://github.com/Effect-TS/effect.git",
						pin: Option.some(new RepoPin({ type: "branch", value: "main" })),
					},
				],
			};
			const result = serializeShelffile(shelffile);
			expect(result).toBe("effect https://github.com/Effect-TS/effect.git pin:branch:main\n");
		});

		test("serializes entries with tag pin", () => {
			const shelffile = {
				entries: [
					{
						alias: "react",
						url: "https://github.com/facebook/react.git",
						pin: Option.some(new RepoPin({ type: "tag", value: "v19.0.0" })),
					},
				],
			};
			const result = serializeShelffile(shelffile);
			expect(result).toBe("react https://github.com/facebook/react.git pin:tag:v19.0.0\n");
		});

		test("serializes entries with commit pin", () => {
			const hash = "abc123def456abc123def456abc123def456abc1";
			const shelffile = {
				entries: [
					{
						alias: "lib",
						url: "https://github.com/test/lib.git",
						pin: Option.some(new RepoPin({ type: "commit", value: hash })),
					},
				],
			};
			const result = serializeShelffile(shelffile);
			expect(result).toBe(`lib https://github.com/test/lib.git pin:${hash}\n`);
		});
	});

	describe("inline comments", () => {
		test("a # comment after an entry is ignored", () => {
			const shelffile = parseShelffile(
				[
					"effect https://github.com/Effect-TS/effect.git # the effect monorepo",
					"react https://github.com/facebook/react.git pin:tag:v19.0.0 # pinned for the docs",
					"lib https://github.com/test/lib.git#readme",
				].join("\n"),
			);
			expect(shelffile.entries.map((e) => [e.alias, e.url])).toEqual([
				["effect", "https://github.com/Effect-TS/effect.git"],
				["react", "https://github.com/facebook/react.git"],
				["lib", "https://github.com/test/lib.git#readme"],
			]);
			expect(Option.isNone(shelffile.entries[0]!.pin)).toBe(true);
			expect(Option.getOrThrow(shelffile.entries[1]!.pin).value).toBe("v19.0.0");
		});
	});

	describe("every stored pin form round-trips", () => {
		const hash = "0123456789abcdef0123456789abcdef01234567";
		test.each([
			["branch", "main"],
			["branch", "cafe123"],
			["tag", "v1.2.3"],
			["commit", hash],
			// Configs written before full hashes were enforced may hold a short one.
			["commit", "abc1234"],
		] as const)("%s pin %s", (type, value) => {
			const entry = {
				alias: "lib",
				url: "https://x/lib.git",
				pin: Option.some(new RepoPin({ type, value })),
			};
			const reparsed = parseShelffile(serializeShelffile({ entries: [entry] })).entries[0]!;
			const pin = Option.getOrThrow(reparsed.pin);
			expect({ type: pin.type, value: pin.value }).toEqual({ type, value });
		});

		test("pin:commit:<hash> parses as a commit pin", () => {
			const pin = parseShelffilePin(`pin:commit:${hash}`);
			expect({ type: pin.type, value: pin.value }).toEqual({ type: "commit", value: hash });
		});

		test("a short bare hash is still rejected", () => {
			expect(() => parseShelffilePin("pin:abc1234")).toThrow(ShelffileParseError);
		});
	});

	describe("round-trip", () => {
		test("parse → serialize → parse produces same result", () => {
			const content = [
				"effect https://github.com/Effect-TS/effect.git pin:branch:main",
				"react https://github.com/facebook/react.git pin:tag:v19.0.0",
				"lib https://github.com/test/lib.git",
			].join("\n");
			const parsed = parseShelffile(content);
			const serialized = serializeShelffile(parsed);
			const reparsed = parseShelffile(serialized);
			expect(reparsed.entries.length).toBe(parsed.entries.length);
			for (let i = 0; i < parsed.entries.length; i++) {
				const original = parsed.entries[i]!;
				const roundTripped = reparsed.entries[i]!;
				expect(roundTripped.alias).toBe(original.alias);
				expect(roundTripped.url).toBe(original.url);
				const origPin = original.pin;
				const rtPin = roundTripped.pin;
				if (Option.isSome(origPin)) {
					expect(Option.isSome(rtPin)).toBe(true);
					if (Option.isSome(rtPin)) {
						expect(rtPin.value.type).toBe(origPin.value.type);
						expect(rtPin.value.value).toBe(origPin.value.value);
					}
				} else {
					expect(Option.isNone(rtPin)).toBe(true);
				}
			}
		});
	});
});

describe("shelffile alias validation", () => {
	test.each([["../evil"], [".."], ["."], ["a/b"], ["-x"], ["a".repeat(101)]])(
		"rejects the alias %p with its line number",
		(alias) => {
			expect(() => parseShelffileLine(`${alias} https://github.com/a/b.git`, 3)).toThrow(
				`Line 3: invalid alias "${alias}"`,
			);
		},
	);

	test("a bad alias anywhere fails the whole shelffile", () => {
		expect(() =>
			parseShelffile("good https://github.com/a/good.git\n../bad https://github.com/a/bad.git\n"),
		).toThrow(ShelffileParseError);
	});
});
