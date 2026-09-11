import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

describe("setup", () => {
	test("bun test works", () => {
		expect(1 + 1).toBe(2);
	});

	test("effect@rc is installed", async () => {
		const program = Effect.succeed(42);
		const result = await Effect.runPromise(program);
		expect(result).toBe(42);
	});
});
