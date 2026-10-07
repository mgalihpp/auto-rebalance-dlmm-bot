import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import bs58 from "bs58";
import Decimal from "decimal.js";
import { Data, Effect } from "effect";
import {
	DEFAULT_JITO_BLOCK_ENGINE_URL,
	JITO_MIN_TIP_LAMPORTS,
	PRIORITY_SETTINGS,
	type PrioritySetting,
} from "./rebalance/send.ts";
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
	feeClaimThresholdLamports: BN | null;
	strategy: StrategyKind;
	priorityLevel: PrioritySetting;
	jitoBundle: boolean;
	jitoTipLamports: number;
	jitoBlockEngineUrl: string;
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
// 0.0001 SOL: between the 75th and 95th landed-tip percentile
// (bundles.jito.wtf/api/v1/bundles/tip_floor), fractions of a cent per
// rebalance. Capped at 0.01 SOL against typos.
export const JITO_TIP_LAMPORTS_DEFAULT = 100_000;
export const JITO_TIP_LAMPORTS_MAX = 10_000_000;
export const FEE_CLAIM_THRESHOLD_SOL_MAX = 1000;
export const SOL_DECIMALS = 9;

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
	| "feeClaimThresholdLamports"
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
		feeClaimThresholdLamports: config.feeClaimThresholdLamports,
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

function httpUrl(
	name: string,
	raw: string,
): Effect.Effect<string, ConfigError> {
	try {
		const url = new URL(raw);
		if (url.protocol === "http:" || url.protocol === "https:") {
			return Effect.succeed(raw);
		}
	} catch {}
	return Effect.fail(
		new ConfigError({ message: `invalid ${name}: expected http(s) URL` }),
	);
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

// "", "off" and "0" disable the sweep. Anything else must be a positive SOL
// amount with at most 9 decimals so the lamport conversion is exact.
export function parseFeeClaimThresholdValue(
	raw: string,
): Effect.Effect<BN | null, ConfigError> {
	const trimmed = raw.trim();
	const lowered = trimmed.toLowerCase();
	if (lowered === "" || lowered === "off" || lowered === "0") {
		return Effect.succeed(null);
	}
	const invalid = new ConfigError({
		message: `invalid FEE_CLAIM_THRESHOLD_SOL: expected off or a SOL amount in (0, ${FEE_CLAIM_THRESHOLD_SOL_MAX}] with at most ${SOL_DECIMALS} decimals, got "${raw}"`,
	});
	if (!/^\d+(\.\d+)?$/.test(trimmed)) {
		return Effect.fail(invalid);
	}
	const sol = new Decimal(trimmed);
	if (
		sol.decimalPlaces() > SOL_DECIMALS ||
		sol.lte(0) ||
		sol.gt(FEE_CLAIM_THRESHOLD_SOL_MAX)
	) {
		return Effect.fail(invalid);
	}
	return Effect.succeed(
		new BN(sol.mul(new Decimal(10).pow(SOL_DECIMALS)).toFixed(0)),
	);
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
		const rpcUrl = yield* httpUrl("RPC_URL", yield* required("RPC_URL", env));

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
		const feeClaimThresholdLamports = yield* parseFeeClaimThresholdValue(
			optional("FEE_CLAIM_THRESHOLD_SOL", env) ?? "",
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
		const jitoBundle = yield* parseBoolVar(
			"JITO_BUNDLE",
			optional("JITO_BUNDLE", env),
			false,
		);
		const jitoTipLamports = yield* parseIntVar(
			"JITO_TIP_LAMPORTS",
			optional("JITO_TIP_LAMPORTS", env),
			JITO_TIP_LAMPORTS_DEFAULT,
			JITO_MIN_TIP_LAMPORTS,
			JITO_TIP_LAMPORTS_MAX,
		);
		const jitoBlockEngineUrl = yield* httpUrl(
			"JITO_BLOCK_ENGINE_URL",
			optional("JITO_BLOCK_ENGINE_URL", env) ?? DEFAULT_JITO_BLOCK_ENGINE_URL,
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
			feeClaimThresholdLamports,
			strategy,
			priorityLevel,
			jitoBundle,
			jitoTipLamports,
			jitoBlockEngineUrl,
			jupiterApiKey,
			secretKey,
			pollIntervalMs,
			telegramPollIntervalMs,
			telegram,
		} satisfies BotConfig;
	});
}
