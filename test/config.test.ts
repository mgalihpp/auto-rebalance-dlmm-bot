import { describe, expect, test } from "bun:test";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { Effect } from "effect";
import { ConfigError, type EnvSource, loadConfig } from "../src/config.ts";

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
