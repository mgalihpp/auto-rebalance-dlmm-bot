import type BN from "bn.js";
import Decimal from "decimal.js";
import { config as loadDotenv } from "dotenv";
import { Effect } from "effect";
import { loadPositionState } from "./rebalance/dlmm.ts";
import { originalHalfRange, shouldRebalance } from "./rebalance/plan.ts";
import {
	describeZapSwap,
	executeZapRebalance,
	planZapRebalance,
	type ZapPlan,
} from "./rebalance/zap.ts";
import { AppConfig, makeAppLive } from "./services.ts";

loadDotenv();

function formatBn(value: BN): string {
	return new Decimal(value.toString()).toFixed(0);
}

function printPreview(
	plan: ZapPlan,
	snapshot: {
		pool: string;
		position: string;
		activeBinId: number;
		lowerBinId: number;
		upperBinId: number;
	},
) {
	const result = plan.estimate.result;
	console.log("=== DLMM auto-rebalance preview (zap) ===");
	console.log(`Pool:            ${snapshot.pool}`);
	console.log(`Position:        ${snapshot.position}`);
	console.log(`Active bin:      ${snapshot.activeBinId}`);
	console.log(
		`Current range:   ${snapshot.lowerBinId} - ${snapshot.upperBinId}`,
	);
	console.log(
		`New range:       active ${snapshot.activeBinId} ` +
			`delta ${plan.minDeltaId}..${plan.maxDeltaId}`,
	);
	console.log(
		`Rebalanced:      X=${formatBn(result.postSwapX)} Y=${formatBn(result.postSwapY)}`,
	);
	console.log(`Swaps required:  ${describeZapSwap(plan.estimate)}`);
	console.log(`Slippage:        ${plan.slippageBps} bps`);
}

let stopped = false;
let wake: (() => void) | undefined;

function requestShutdown() {
	console.log("Shutting down...");
	stopped = true;
	wake?.();
}

process.on("SIGINT", requestShutdown);
process.on("SIGTERM", requestShutdown);

const appLive = makeAppLive(process.env);

const pollIntervalMs = await Effect.runPromise(
	Effect.provide(
		Effect.gen(function* () {
			const config = yield* AppConfig;
			return config.pollIntervalMs;
		}),
		appLive,
	),
).catch((error): never => {
	console.error("Rebalance failed:", error);
	process.exit(1);
});

function runIteration() {
	return Effect.gen(function* () {
		const config = yield* AppConfig;
		const state = yield* loadPositionState({
			poolAddress: config.poolAddress,
		});
		const snapshot = state.snapshot;

		if (
			!shouldRebalance(
				snapshot.activeBinId,
				snapshot.lowerBinId,
				snapshot.upperBinId,
			)
		) {
			console.log(
				`Position in range (active ${snapshot.activeBinId} within ${snapshot.lowerBinId}-${snapshot.upperBinId}) — no rebalance needed.`,
			);
			return;
		}

		const halfWidth = originalHalfRange(
			snapshot.lowerBinId,
			snapshot.upperBinId,
		);
		const plan = yield* planZapRebalance({
			poolAddress: config.poolAddress,
			positionAddress: snapshot.position,
			strategy: config.strategy,
			slippageBps: config.slippageBps,
			halfWidth,
			jupiterApiKey: config.jupiterApiKey,
		});
		printPreview(plan, {
			pool: snapshot.pool,
			position: snapshot.position,
			activeBinId: snapshot.activeBinId,
			lowerBinId: snapshot.lowerBinId,
			upperBinId: snapshot.upperBinId,
		});

		if (config.dryRun) {
			console.log("Dry run — no transactions sent.");
			return;
		}

		const done = yield* executeZapRebalance({ plan });
		console.log(`Rebalanced via zap: ${done.signature}`);
	});
}

while (!stopped) {
	try {
		await Effect.runPromise(Effect.provide(runIteration(), appLive));
	} catch (error) {
		console.error("Rebalance failed:", error);
	}
	if (stopped) {
		break;
	}
	await new Promise<void>((resolve) => {
		wake = resolve;
		setTimeout(resolve, pollIntervalMs);
	});
	wake = undefined;
}
