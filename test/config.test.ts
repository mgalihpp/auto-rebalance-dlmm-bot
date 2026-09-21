import { describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { Effect } from "effect";
import {
	ConfigError,
	type EnvSource,
	loadConfig,
	parseCompoundFeesValue,
	parsePollIntervalValue,
	parsePoolAddressValue,
	parsePriorityLevelValue,
	parseSlippageBpsValue,
	parseStrategyValue,
	parseTelegramPollIntervalValue,
	tunablesFromConfig,
} from "../src/config.ts";

function makeEnv(overrides?: EnvSource): EnvSource {
	return {
		RPC_URL: "https://api.mainnet-beta.solana.com",
		POOL_ADDRESS: Keypair.generate().publicKey.toBase58(),
		PRIVATE_KEY: bs58.encode(Keypair.generate().secretKey),
		...overrides,
	};
}

async function loadFailure(env: EnvSource): Promise<unknown> {
	try {
		await Effect.runPromise(loadConfig(env));
	} catch (error) {
		return error;
	}
	return expect.unreachable();
}

describe("loadConfig poll interval", () => {
	test("defaults to 60000 when unset", async () => {
		const config = await Effect.runPromise(loadConfig(makeEnv()));
		expect(config.pollIntervalMs).toBe(60000);
	});

	test("accepts a valid custom value", async () => {
		const config = await Effect.runPromise(
			loadConfig(makeEnv({ POLL_INTERVAL_MS: "10000" })),
		);
		expect(config.pollIntervalMs).toBe(10000);
	});

	test("rejects below-min with ConfigError", async () => {
		const error = await loadFailure(makeEnv({ POLL_INTERVAL_MS: "1000" }));
		expect(error).toBeInstanceOf(ConfigError);
	});

	test("rejects non-integer with ConfigError", async () => {
		const error = await loadFailure(makeEnv({ POLL_INTERVAL_MS: "abc" }));
		expect(error).toBeInstanceOf(ConfigError);
	});
});

describe("loadConfig priority level", () => {
	test("defaults to High when unset", async () => {
		const config = await Effect.runPromise(loadConfig(makeEnv()));
		expect(config.priorityLevel).toBe("High");
	});

	test("accepts any Helius level case-insensitively", async () => {
		const config = await Effect.runPromise(
			loadConfig(makeEnv({ PRIORITY_LEVEL: "veryhigh" })),
		);
		expect(config.priorityLevel).toBe("VeryHigh");
	});

	test("accepts Auto for Helius-recommended fee", async () => {
		const config = await Effect.runPromise(
			loadConfig(makeEnv({ PRIORITY_LEVEL: "auto" })),
		);
		expect(config.priorityLevel).toBe("Auto");
	});
	test("rejects unknown levels with ConfigError", async () => {
		const error = await loadFailure(makeEnv({ PRIORITY_LEVEL: "Ultra" }));
		expect(error).toBeInstanceOf(ConfigError);
	});
});

describe("loadConfig compound fees", () => {
	test("defaults to false when unset", async () => {
		const config = await Effect.runPromise(loadConfig(makeEnv()));
		expect(config.compoundFees).toBe(false);
	});

	test.each(["true", "1", "yes", "TRUE", "Yes"])(
		"accepts %s as true",
		async (value) => {
			const config = await Effect.runPromise(
				loadConfig(makeEnv({ COMPOUND_FEES: value })),
			);
			expect(config.compoundFees).toBe(true);
		},
	);

	test.each(["false", "0", "no", "FALSE", "No"])(
		"accepts %s as false",
		async (value) => {
			const config = await Effect.runPromise(
				loadConfig(makeEnv({ COMPOUND_FEES: value })),
			);
			expect(config.compoundFees).toBe(false);
		},
	);

	test("rejects invalid values with ConfigError", async () => {
		const error = await loadFailure(makeEnv({ COMPOUND_FEES: "sometimes" }));
		expect(error).toBeInstanceOf(ConfigError);
	});
});

describe("strict single-value parsers (Telegram registry reuse)", () => {
	test("slippage accepts bounds, rejects empty and out-of-range", async () => {
		expect(await Effect.runPromise(parseSlippageBpsValue("0"))).toBe(0);
		expect(await Effect.runPromise(parseSlippageBpsValue("10000"))).toBe(10000);
		for (const bad of ["", "   ", "-1", "10001", "abc"]) {
			const error = await Effect.runPromise(
				Effect.flip(parseSlippageBpsValue(bad)),
			);
			expect(error).toBeInstanceOf(ConfigError);
		}
	});

	test("poll intervals enforce startup bounds", async () => {
		expect(await Effect.runPromise(parsePollIntervalValue("5000"))).toBe(5000);
		expect(await Effect.runPromise(parsePollIntervalValue("3600000"))).toBe(
			3600000,
		);
		expect(
			await Effect.runPromise(parseTelegramPollIntervalValue("1000")),
		).toBe(1000);
		expect(
			await Effect.runPromise(parseTelegramPollIntervalValue("60000")),
		).toBe(60000);
		for (const bad of ["", "4999", "3600001", "abc"]) {
			const error = await Effect.runPromise(
				Effect.flip(parsePollIntervalValue(bad)),
			);
			expect(error).toBeInstanceOf(ConfigError);
		}
		for (const bad of ["", "999", "60001"]) {
			const error = await Effect.runPromise(
				Effect.flip(parseTelegramPollIntervalValue(bad)),
			);
			expect(error).toBeInstanceOf(ConfigError);
		}
		const telegramError = await Effect.runPromise(
			Effect.flip(parseTelegramPollIntervalValue("")),
		);
		expect(telegramError).toBeInstanceOf(ConfigError);
	});

	test("strategy accepts aliases, rejects unknown", async () => {
		expect(await Effect.runPromise(parseStrategyValue("bid-ask"))).toBe(
			"BidAsk",
		);
		expect(await Effect.runPromise(parseStrategyValue("bid_ask"))).toBe(
			"BidAsk",
		);
		const error = await Effect.runPromise(
			Effect.flip(parseStrategyValue("sideways")),
		);
		expect(error).toBeInstanceOf(ConfigError);
	});

	test("compound fees accepts bool words, rejects unknown", async () => {
		expect(await Effect.runPromise(parseCompoundFeesValue("yes"))).toBe(true);
		expect(await Effect.runPromise(parseCompoundFeesValue("0"))).toBe(false);
		const error = await Effect.runPromise(
			Effect.flip(parseCompoundFeesValue("sometimes")),
		);
		expect(error).toBeInstanceOf(ConfigError);
	});

	test("priority level is case-insensitive, rejects unknown", async () => {
		expect(await Effect.runPromise(parsePriorityLevelValue("AUTO"))).toBe(
			"Auto",
		);
		const error = await Effect.runPromise(
			Effect.flip(parsePriorityLevelValue("Ultra")),
		);
		expect(error).toBeInstanceOf(ConfigError);
	});

	test("pool address validates base58, trims whitespace", async () => {
		const pool = Keypair.generate().publicKey.toBase58();
		expect(await Effect.runPromise(parsePoolAddressValue(`  ${pool}  `))).toBe(
			pool,
		);
		for (const bad of ["", "   ", "not-an-address"]) {
			const error = await Effect.runPromise(
				Effect.flip(parsePoolAddressValue(bad)),
			);
			expect(error).toBeInstanceOf(ConfigError);
		}
	});

	test("tunablesFromConfig picks exactly the editable slice", async () => {
		const config = await Effect.runPromise(loadConfig(makeEnv()));
		const tunables = tunablesFromConfig(config);
		expect(Object.keys(tunables).sort()).toEqual(
			[
				"compoundFees",
				"reaccumulateFeesToSol",
				"pollIntervalMs",
				"poolAddress",
				"priorityLevel",
				"slippageBps",
				"strategy",
				"telegramPollIntervalMs",
			].sort(),
		);
		expect(tunables.poolAddress).toBe(config.poolAddress);
		expect("dryRun" in tunables).toBe(false);
		expect("secretKey" in tunables).toBe(false);
		expect("rpcUrl" in tunables).toBe(false);
	});
});
