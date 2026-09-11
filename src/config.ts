import { PublicKey } from "@solana/web3.js";
import { Effect } from "effect";
import type { LiquidityStrategy } from "./decision.ts";

export interface BotConfig {
	rpcUrl: string;
	walletPrivateKey: string | null;
	poolAddress: string;
	positionPubkey: string | null;
	strategy: LiquidityStrategy;
	checkIntervalMs: number;
	slippageBps: number;
	dryRun: boolean;
	edgeBufferBins: number;
}

export class ConfigError extends Error {
	readonly _tag = "ConfigError";
}

const fail = (msg: string): Effect.Effect<never, ConfigError> =>
	Effect.fail(new ConfigError(msg));

function parsePositiveInt(
	raw: string | undefined,
	fallback: number,
	name: string,
): Effect.Effect<number, ConfigError> {
	if (raw === undefined || raw.trim() === "") return Effect.succeed(fallback);
	const n = Number(raw);
	if (!Number.isInteger(n) || n <= 0) {
		return fail(`${name} must be a positive integer, got "${raw}"`);
	}
	return Effect.succeed(n);
}

function parseNonNegativeInt(
	raw: string | undefined,
	fallback: number,
	name: string,
): Effect.Effect<number, ConfigError> {
	if (raw === undefined || raw.trim() === "") return Effect.succeed(fallback);
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 0) {
		return fail(`${name} must be a non-negative integer, got "${raw}"`);
	}
	return Effect.succeed(n);
}

function parseStrategy(
	raw: string | undefined,
): Effect.Effect<LiquidityStrategy, ConfigError> {
	if (raw === undefined || raw.trim() === "") return Effect.succeed("Spot");
	const name = raw.trim().toLowerCase();
	if (name === "spot") return Effect.succeed("Spot");
	if (name === "curve") return Effect.succeed("Curve");
	if (name === "bidask" || name === "bid-ask" || name === "bid_ask")
		return Effect.succeed("BidAsk");
	return fail(
		`STRATEGY must be Spot, Curve, or BidAsk, got "${raw}"`,
	);
}

function parseDryRun(raw: string | undefined): boolean {
	if (raw === undefined || raw.trim() === "") return true;
	return raw.trim().toLowerCase() !== "false";
}

function assertPubkey(
	raw: string,
	name: string,
): Effect.Effect<string, ConfigError> {
	try {
		new PublicKey(raw.trim());
		return Effect.succeed(raw.trim());
	} catch {
		return fail(`${name} is not a valid Solana address: "${raw}"`);
	}
}

export const loadConfig = (): Effect.Effect<BotConfig, ConfigError> =>
	Effect.gen(function* () {
		const env = process.env;

		const rpcUrl = (env.RPC_URL ?? "").trim();
		if (!rpcUrl) {
			return yield* fail(
				"RPC_URL is missing. Copy .env.example to .env and set RPC_URL (e.g. https://api.mainnet-beta.solana.com).",
			);
		}
		try {
			const u = new URL(rpcUrl);
			if (u.protocol !== "http:" && u.protocol !== "https:") {
				return yield* fail(`RPC_URL must be http(s) URL, got "${rpcUrl}"`);
			}
		} catch {
			return yield* fail(`RPC_URL is not a valid URL: "${rpcUrl}"`);
		}

		const poolRaw = (env.POOL_ADDRESS ?? "").trim();
		if (!poolRaw) {
			return yield* fail(
				"POOL_ADDRESS is missing. Copy .env.example to .env and set POOL_ADDRESS to your DOGE/SOL DLMM pool address.",
			);
		}
		const poolAddress = yield* assertPubkey(poolRaw, "POOL_ADDRESS");

		const posRaw = (env.POSITION_PUBKEY ?? "").trim();
		let positionPubkey: string | null = null;
		if (posRaw) {
			positionPubkey = yield* assertPubkey(posRaw, "POSITION_PUBKEY");
		}

		const walletRaw = (env.WALLET_PRIVATE_KEY ?? "").trim();
		const walletPrivateKey = walletRaw ? walletRaw : null;
		const strategy = yield* parseStrategy(env.STRATEGY);
		const checkIntervalMs = yield* parsePositiveInt(
			env.CHECK_INTERVAL_MS,
			60000,
			"CHECK_INTERVAL_MS",
		);
		const slippageBps = yield* parseNonNegativeInt(
			env.SLIPPAGE_BPS,
			100,
			"SLIPPAGE_BPS",
		);
		const edgeBufferBins = yield* parseNonNegativeInt(
			env.EDGE_BUFFER_BINS,
			2,
			"EDGE_BUFFER_BINS",
		);

		return {
			rpcUrl,
			walletPrivateKey,
			poolAddress,
			positionPubkey,
			strategy,
			checkIntervalMs,
			slippageBps,
			dryRun: parseDryRun(env.DRY_RUN),
			edgeBufferBins,
		} satisfies BotConfig;
	});
