// LIVE rebalance trigger. Sends REAL transactions against the pool in .env
// via the zap-sdk engine (same as the Meteora UI): estimate the balancing
// swap, then remove -> swap -> zap back in. No drift gate, no dry-run,
// no index.ts.
//
// Usage: bun run scripts/test-rebalance.ts --live
// Without --live this script exits immediately without touching RPC.
import { config as loadDotenv } from "dotenv";
import { Effect } from "effect";
import { loadPositionState } from "../src/rebalance/dlmm.ts";
import { originalHalfRange } from "../src/rebalance/plan.ts";
import { nowStamp } from "../src/rebalance/send.ts";
import {
	describeZapSwap,
	executeZapRebalance,
	planZapRebalance,
} from "../src/rebalance/zap.ts";
import { AppConfig, makeAppLive } from "../src/services.ts";

if (!process.argv.includes("--live")) {
	console.error(
		`[${nowStamp()}] REFUSING: this script sends REAL transactions.`,
	);
	console.error(
		`[${nowStamp()}] Usage: bun run scripts/test-rebalance.ts --live`,
	);
	process.exit(2);
}

console.log(`[${nowStamp()}] === LIVE REBALANCE TRIGGER (zap) ===`);
console.log(`[${nowStamp()}] Real transactions in 5s. Ctrl+C to abort.`);

loadDotenv();

const main = Effect.gen(function* () {
	const botConfig = yield* AppConfig;

	const state = yield* loadPositionState({
		poolAddress: botConfig.poolAddress,
	});
	const snapshot = state.snapshot;
	const halfWidth = originalHalfRange(snapshot.lowerBinId, snapshot.upperBinId);
	console.log(
		`[${nowStamp()}] Rebalancing ${snapshot.position} (active ${snapshot.activeBinId}, ` +
			`range ${snapshot.lowerBinId}-${snapshot.upperBinId}) -> ` +
			`${botConfig.strategy} delta -${halfWidth}..+${halfWidth}`,
	);

	const plan = yield* planZapRebalance({
		poolAddress: botConfig.poolAddress,
		positionAddress: snapshot.position,
		strategy: botConfig.strategy,
		slippageBps: botConfig.slippageBps,
		halfWidth,
		jupiterApiKey: botConfig.jupiterApiKey,
	});
	const result = plan.estimate.result;
	console.log(
		`[${nowStamp()}] Swap: ${describeZapSwap(plan.estimate)} -> ` +
			`X=${result.postSwapX.toString()} Y=${result.postSwapY.toString()}`,
	);

	const done = yield* executeZapRebalance({ plan });
	console.log(`[${nowStamp()}] Rebalanced via zap: ${done.signature}`);
});

Effect.runPromise(Effect.provide(main, makeAppLive(process.env))).then(
	() => process.exit(0),
	(error) => {
		console.error(`[${nowStamp()}] Live rebalance failed:`, error);
		process.exit(1);
	},
);
