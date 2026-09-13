import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { Data, Effect } from "effect";
import { PRIORITY_SETTINGS, type PrioritySetting } from "./rebalance/send.ts";
import type { StrategyKind } from "./rebalance/types.ts";

export class ConfigError extends Data.TaggedError("ConfigError")<{
	message: string;
}> {}

export interface BotConfig {
	rpcUrl: string;
	poolAddress: string;
	slippageBps: number;
	dryRun: boolean;
	strategy: StrategyKind;
	priorityLevel: PrioritySetting;
	jupiterApiKey?: string;
	secretKey: Uint8Array;
	pollIntervalMs: number;
}

export type EnvSource = Record<string, string | undefined>;

function required(
	name: string,
	env: EnvSource,
): Effect.Effect<string, ConfigError> {
	const value = env[name]?.trim();
	if (!value) {
		return Effect.fail(
			new ConfigError({ message: `missing required env var ${name}` }),
		);
	}
	return Effect.succeed(value);
}

function optional(name: string, env: EnvSource): string | undefined {
	const value = env[name]?.trim();
	return value ? value : undefined;
}

function parseIntVar(
	name: string,
	raw: string | undefined,
	fallback: number,
	min: number,
	max: number,
): Effect.Effect<number, ConfigError> {
	if (raw === undefined || raw === "") {
		return Effect.succeed(fallback);
	}
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
		return Effect.fail(
			new ConfigError({
				message: `invalid ${name}: expected integer in [${min}, ${max}], got "${raw}"`,
			}),
		);
	}
	return Effect.succeed(parsed);
}

function asPublicKey(
	name: string,
	raw: string,
): Effect.Effect<PublicKey, ConfigError> {
	try {
		return Effect.succeed(new PublicKey(raw));
	} catch {
		return Effect.fail(
			new ConfigError({
				message: `invalid ${name}: not a valid Solana address`,
			}),
		);
	}
}

function parseBoolVar(
	name: string,
	raw: string | undefined,
	fallback: boolean,
): Effect.Effect<boolean, ConfigError> {
	if (raw === undefined || raw === "") {
		return Effect.succeed(fallback);
	}
	const normalized = raw.trim().toLowerCase();
	if (normalized === "true" || normalized === "1" || normalized === "yes") {
		return Effect.succeed(true);
	}
	if (normalized === "false" || normalized === "0" || normalized === "no") {
		return Effect.succeed(false);
	}
	return Effect.fail(
		new ConfigError({
			message: `invalid ${name}: expected true/false, got "${raw}"`,
		}),
	);
}

function parseStrategyVar(
	name: string,
	raw: string | undefined,
	fallback: StrategyKind,
): Effect.Effect<StrategyKind, ConfigError> {
	if (raw === undefined || raw === "") {
		return Effect.succeed(fallback);
	}
	const normalized = raw.trim().toLowerCase();
	if (normalized === "spot") {
		return Effect.succeed("Spot");
	}
	if (normalized === "curve") {
		return Effect.succeed("Curve");
	}
	if (
		normalized === "bidask" ||
		normalized === "bid-ask" ||
		normalized === "bid_ask"
	) {
		return Effect.succeed("BidAsk");
	}
	return Effect.fail(
		new ConfigError({
			message: `invalid ${name}: expected Spot|Curve|BidAsk, got "${raw}"`,
		}),
	);
}
function parsePriorityLevelVar(
	name: string,
	raw: string | undefined,
	fallback: PrioritySetting,
): Effect.Effect<PrioritySetting, ConfigError> {
	if (raw === undefined || raw === "") {
		return Effect.succeed(fallback);
	}
	const normalized = raw.trim().toLowerCase();
	const found = PRIORITY_SETTINGS.find(
		(level) => level.toLowerCase() === normalized,
	);
	if (found !== undefined) {
		return Effect.succeed(found);
	}
	return Effect.fail(
		new ConfigError({
			message: `invalid ${name}: expected ${PRIORITY_SETTINGS.join("|")}, got "${raw}"`,
		}),
	);
}

export function loadConfig(
	env: EnvSource,
): Effect.Effect<BotConfig, ConfigError> {
	return Effect.gen(function* () {
		const rpcUrl = yield* required("RPC_URL", env);
		try {
			const url = new URL(rpcUrl);
			if (url.protocol !== "http:" && url.protocol !== "https:") {
				return yield* new ConfigError({
					message: "invalid RPC_URL: expected http(s) URL",
				});
			}
		} catch {
			return yield* new ConfigError({
				message: "invalid RPC_URL: expected http(s) URL",
			});
		}

		const poolRaw = yield* required("POOL_ADDRESS", env);
		const poolKey = yield* asPublicKey("POOL_ADDRESS", poolRaw);

		const privateRaw = yield* required("PRIVATE_KEY", env);
		let secretKey: Uint8Array;
		try {
			secretKey = bs58.decode(privateRaw);
		} catch {
			return yield* new ConfigError({
				message: "invalid PRIVATE_KEY: not valid bs58",
			});
		}
		if (secretKey.length !== 64) {
			return yield* new ConfigError({
				message: "invalid PRIVATE_KEY: expected 64-byte secret key",
			});
		}

		const slippageBps = yield* parseIntVar(
			"SLIPPAGE_BPS",
			optional("SLIPPAGE_BPS", env),
			50,
			0,
			10_000,
		);
		const dryRun = yield* parseBoolVar(
			"DRY_RUN",
			optional("DRY_RUN", env),
			true,
		);
		const strategy = yield* parseStrategyVar(
			"STRATEGY",
			optional("STRATEGY", env),
			"Curve",
		);
		const priorityLevel = yield* parsePriorityLevelVar(
			"PRIORITY_LEVEL",
			optional("PRIORITY_LEVEL", env),
			"High",
		);
		const jupiterApiKey = optional("JUPITER_API_KEY", env);
		const pollIntervalMs = yield* parseIntVar(
			"POLL_INTERVAL_MS",
			optional("POLL_INTERVAL_MS", env),
			60000,
			5000,
			3600000,
		);

		return {
			rpcUrl,
			poolAddress: poolKey.toBase58(),
			slippageBps,
			dryRun,
			strategy,
			priorityLevel,
			jupiterApiKey,
			secretKey,
			pollIntervalMs,
		} satisfies BotConfig;
	});
}
