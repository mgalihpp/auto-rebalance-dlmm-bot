import { afterEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { ConfigError, loadConfig } from "../src/config.ts";

const POOL = "11111111111111111111111111111111";
const RPC = "https://api.mainnet-beta.solana.com";

const baseEnv = {
	RPC_URL: RPC,
	POOL_ADDRESS: POOL,
};

const runConfig = () => Effect.runPromise(loadConfig());

const withEnv = async (
	vars: Record<string, string | undefined>,
	fn: () => Promise<void>,
): Promise<void> => {
	const prev = { ...process.env };
	for (const [k, v] of Object.entries(vars)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	try {
		await fn();
	} finally {
		for (const k of Object.keys(vars)) delete process.env[k];
		for (const [k, v] of Object.entries(prev)) {
			if (k in vars) process.env[k] = v;
		}
	}
};

describe("COMPOUND_FEES", () => {
	afterEach(() => {
		delete process.env.COMPOUND_FEES;
	});

	it("parses true", async () => {
		await withEnv({ ...baseEnv, COMPOUND_FEES: "true" }, async () => {
			const c = await runConfig();
			expect(c.compoundFees).toBe(true);
		});
	});

	it("parses false", async () => {
		await withEnv({ ...baseEnv, COMPOUND_FEES: "false" }, async () => {
			const c = await runConfig();
			expect(c.compoundFees).toBe(false);
		});
	});

	it("defaults to false when empty", async () => {
		await withEnv(
			{ ...baseEnv, COMPOUND_FEES: undefined },
			async () => {
				delete process.env.COMPOUND_FEES;
				const c = await runConfig();
				expect(c.compoundFees).toBe(false);
			},
		);
	});

	it("rejects garbage with a typed ConfigError", async () => {
		await withEnv({ ...baseEnv, COMPOUND_FEES: "yes" }, async () => {
			const err = await Effect.runPromise(Effect.flip(loadConfig()));
			expect(err).toBeInstanceOf(ConfigError);
			expect(err.message).toContain("COMPOUND_FEES");
		});
	});
});
