import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { Data, Effect } from "effect";
import { PRIORITY_SETTINGS, type PrioritySetting } from "./rebalance/send.ts";
import type { StrategyKind } from "./rebalance/types.ts";

export class ConfigError extends Data.TaggedError("ConfigError")<{
	message: string;
}> {}

export interface TelegramConfig {
	botToken: string;
	chatId: string;
}

export interface BotConfig {
	rpcUrl: string;
	poolAddress: string;
	slippageBps: number;
	dryRun: boolean;
	compoundFees: boolean;
	reaccumulateFeesToSol: boolean;
	strategy: StrategyKind;
	priorityLevel: PrioritySetting;
	jupiterApiKey?: string;
	secretKey: Uint8Array;
	pollIntervalMs: number;
	telegramPollIntervalMs: number;
	telegram?: TelegramConfig;
}

export type EnvSource = Record<string, string | undefined>;

// Single source for editable bounds. loadConfig and the Telegram registry
// below both read these, so chat edits can never drift from startup validation.
export const SLIPPAGE_BPS_MIN = 0;
export const SLIPPAGE_BPS_MAX = 10_000;
export const SLIPPAGE_BPS_DEFAULT = 50;
export const POLL_INTERVAL_MS_MIN = 5000;
export const POLL_INTERVAL_MS_MAX = 3600000;
export const POLL_INTERVAL_MS_DEFAULT = 60000;
export const TELEGRAM_POLL_INTERVAL_MS_MIN = 1000;
export const TELEGRAM_POLL_INTERVAL_MS_MAX = 60000;
export const TELEGRAM_POLL_INTERVAL_MS_DEFAULT = 3000;

// Mutable runtime tunables: everything Telegram may edit. DRY_RUN, RPC_URL,
// PRIVATE_KEY, TELEGRAM_* credentials and JUPITER_API_KEY stay startup-only.
export type Tunables = Pick<
	BotConfig,
	| "poolAddress"
	| "slippageBps"
	| "pollIntervalMs"
	| "telegramPollIntervalMs"
	| "strategy"
	| "compoundFees"
	| "reaccumulateFeesToSol"
	| "priorityLevel"
>;

export function tunablesFromConfig(config: BotConfig): Tunables {
	return {
		poolAddress: config.poolAddress,
		slippageBps: config.slippageBps,
		pollIntervalMs: config.pollIntervalMs,
		telegramPollIntervalMs: config.telegramPollIntervalMs,
		strategy: config.strategy,
		compoundFees: config.compoundFees,
		reaccumulateFeesToSol: config.reaccumulateFeesToSol,
		priorityLevel: config.priorityLevel,
	};
}

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

// Strict single-value parsers for Telegram edits. Same helpers, same bounds
// and messages as loadConfig; empty input fails instead of falling back.
export function parseSlippageBpsValue(
	raw: string,
): Effect.Effect<number, ConfigError> {
	const trimmed = raw.trim();
	if (trimmed === "") {
		return Effect.fail(
			new ConfigError({
				message: `invalid SLIPPAGE_BPS: expected integer in [${SLIPPAGE_BPS_MIN}, ${SLIPPAGE_BPS_MAX}], got "${raw}"`,
			}),
		);
	}
	return parseIntVar(
		"SLIPPAGE_BPS",
		trimmed,
		SLIPPAGE_BPS_DEFAULT,
		SLIPPAGE_BPS_MIN,
		SLIPPAGE_BPS_MAX,
	);
}

export function parsePollIntervalValue(
	raw: string,
): Effect.Effect<number, ConfigError> {
	const trimmed = raw.trim();
	if (trimmed === "") {
		return Effect.fail(
			new ConfigError({
				message: `invalid POLL_INTERVAL_MS: expected integer in [${POLL_INTERVAL_MS_MIN}, ${POLL_INTERVAL_MS_MAX}], got "${raw}"`,
			}),
		);
	}
	return parseIntVar(
		"POLL_INTERVAL_MS",
		trimmed,
		POLL_INTERVAL_MS_DEFAULT,
		POLL_INTERVAL_MS_MIN,
		POLL_INTERVAL_MS_MAX,
	);
}

export function parseTelegramPollIntervalValue(
	raw: string,
): Effect.Effect<number, ConfigError> {
	const trimmed = raw.trim();
	if (trimmed === "") {
		return Effect.fail(
			new ConfigError({
				message: `invalid TELEGRAM_POLL_INTERVAL_MS: expected integer in [${TELEGRAM_POLL_INTERVAL_MS_MIN}, ${TELEGRAM_POLL_INTERVAL_MS_MAX}], got "${raw}"`,
			}),
		);
	}
	return parseIntVar(
		"TELEGRAM_POLL_INTERVAL_MS",
		trimmed,
		TELEGRAM_POLL_INTERVAL_MS_DEFAULT,
		TELEGRAM_POLL_INTERVAL_MS_MIN,
		TELEGRAM_POLL_INTERVAL_MS_MAX,
	);
}

export function parseStrategyValue(
	raw: string,
): Effect.Effect<StrategyKind, ConfigError> {
	const trimmed = raw.trim();
	if (trimmed === "") {
		return Effect.fail(
			new ConfigError({
				message: `invalid STRATEGY: expected Spot|Curve|BidAsk, got "${raw}"`,
			}),
		);
	}
	return parseStrategyVar("STRATEGY", trimmed, "Curve");
}

export function parseCompoundFeesValue(
	raw: string,
): Effect.Effect<boolean, ConfigError> {
	const trimmed = raw.trim();
	if (trimmed === "") {
		return Effect.fail(
			new ConfigError({
				message: `invalid COMPOUND_FEES: expected true/false, got "${raw}"`,
			}),
		);
	}
	return parseBoolVar("COMPOUND_FEES", trimmed, false);
}

export function parseReaccumulateFeesToSolValue(
	raw: string,
): Effect.Effect<boolean, ConfigError> {
	const trimmed = raw.trim();
	if (trimmed === "") {
		return Effect.fail(
			new ConfigError({
				message: `invalid REACCUMULATE_FEES_TO_SOL: expected true/false, got "${raw}"`,
			}),
		);
	}
	return parseBoolVar("REACCUMULATE_FEES_TO_SOL", trimmed, false);
}

export function parsePriorityLevelValue(
	raw: string,
): Effect.Effect<PrioritySetting, ConfigError> {
	const trimmed = raw.trim();
	if (trimmed === "") {
		return Effect.fail(
			new ConfigError({
				message: `invalid PRIORITY_LEVEL: expected ${PRIORITY_SETTINGS.join("|")}, got "${raw}"`,
			}),
		);
	}
	return parsePriorityLevelVar("PRIORITY_LEVEL", trimmed, "High");
}

export function parsePoolAddressValue(
	raw: string,
): Effect.Effect<string, ConfigError> {
	const trimmed = raw.trim();
	if (trimmed === "") {
		return Effect.fail(
			new ConfigError({
				message: "invalid POOL_ADDRESS: not a valid Solana address",
			}),
		);
	}
	return Effect.map(asPublicKey("POOL_ADDRESS", trimmed), (key) =>
		key.toBase58(),
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
			SLIPPAGE_BPS_DEFAULT,
			SLIPPAGE_BPS_MIN,
			SLIPPAGE_BPS_MAX,
		);
		const dryRun = yield* parseBoolVar(
			"DRY_RUN",
			optional("DRY_RUN", env),
			true,
		);
		const compoundFees = yield* parseBoolVar(
			"COMPOUND_FEES",
			optional("COMPOUND_FEES", env),
			false,
		);
		const reaccumulateFeesToSol = yield* parseBoolVar(
			"REACCUMULATE_FEES_TO_SOL",
			optional("REACCUMULATE_FEES_TO_SOL", env),
			false,
		);
		if (compoundFees && reaccumulateFeesToSol) {
			return yield* new ConfigError({
				message:
					"invalid config: COMPOUND_FEES and REACCUMULATE_FEES_TO_SOL are mutually exclusive; enable at most one",
			});
		}
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
			POLL_INTERVAL_MS_DEFAULT,
			POLL_INTERVAL_MS_MIN,
			POLL_INTERVAL_MS_MAX,
		);
		const telegramPollIntervalMs = yield* parseIntVar(
			"TELEGRAM_POLL_INTERVAL_MS",
			optional("TELEGRAM_POLL_INTERVAL_MS", env),
			TELEGRAM_POLL_INTERVAL_MS_DEFAULT,
			TELEGRAM_POLL_INTERVAL_MS_MIN,
			TELEGRAM_POLL_INTERVAL_MS_MAX,
		);

		const botToken = optional("TELEGRAM_BOT_TOKEN", env);
		const chatId = optional("TELEGRAM_CHAT_ID", env);
		let telegram: TelegramConfig | undefined;
		if (!botToken && !chatId) {
			telegram = undefined;
		} else if (botToken && chatId) {
			telegram = { botToken, chatId };
		} else {
			return yield* new ConfigError({
				message:
					"invalid Telegram config: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must both be set or both absent",
			});
		}

		return {
			rpcUrl,
			poolAddress: poolKey.toBase58(),
			slippageBps,
			dryRun,
			compoundFees,
			reaccumulateFeesToSol,
			strategy,
			priorityLevel,
			jupiterApiKey,
			secretKey,
			pollIntervalMs,
			telegramPollIntervalMs,
			telegram,
		} satisfies BotConfig;
	});
}
