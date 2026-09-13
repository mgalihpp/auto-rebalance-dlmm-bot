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
import { formatBn, nowStamp } from "./utils.ts";

loadDotenv();

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
	console.log(`[${nowStamp()}] === DLMM auto-rebalance preview (zap) ===`);
	console.log(`[${nowStamp()}] Pool:            ${snapshot.pool}`);
	console.log(`[${nowStamp()}] Position:        ${snapshot.position}`);
	console.log(`[${nowStamp()}] Active bin:      ${snapshot.activeBinId}`);
	console.log(
		`[${nowStamp()}] Current range:   ${snapshot.lowerBinId} - ${snapshot.upperBinId}`,
	);
	console.log(
		`[${nowStamp()}] New range:       active ${snapshot.activeBinId} ` +
			`delta ${plan.minDeltaId}..${plan.maxDeltaId}`,
	);
	console.log(
		`[${nowStamp()}] Rebalanced:      X=${formatBn(result.postSwapX)} Y=${formatBn(result.postSwapY)}`,
	);
	console.log(
		`[${nowStamp()}] Swaps required:  ${describeZapSwap(plan.estimate)}`,
	);
	console.log(`[${nowStamp()}] Slippage:        ${plan.slippageBps} bps`);
}

let stopped = false;
let wake: (() => void) | undefined;

function requestShutdown() {
	console.log(`[${nowStamp()}] Shutting down...`);
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
	console.error(`[${nowStamp()}] Rebalance failed:`, error);
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
				`[${nowStamp()}] Position in range (active ${snapshot.activeBinId} within ${snapshot.lowerBinId}-${snapshot.upperBinId}) — no rebalance needed.`,
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
			console.log(`[${nowStamp()}] Dry run — no transactions sent.`);
			return;
		}

		const done = yield* executeZapRebalance({ plan });
		console.log(`[${nowStamp()}] Rebalanced via zap: ${done.signature}`);
	});
}

while (!stopped) {
	try {
		await Effect.runPromise(Effect.provide(runIteration(), appLive));
	} catch (error) {
		console.error(`[${nowStamp()}] Rebalance failed:`, error);
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
