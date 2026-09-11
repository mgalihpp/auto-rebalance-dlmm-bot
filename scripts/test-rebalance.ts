// LIVE rebalance trigger. Sends REAL transactions against the pool in .env
// via the zap-sdk engine (same as the Meteora UI): estimate the balancing
// swap, then remove -> swap -> zap back in. No drift gate, no dry-run,
// no index.ts.
//
// Usage: bun run scripts/test-rebalance.ts --live
// Without --live this script exits immediately without touching RPC.
import { Connection, Keypair } from "@solana/web3.js";
import { config as loadDotenv } from "dotenv";
import { Effect } from "effect";
import { loadConfig } from "../src/config.ts";
import { loadPositionState } from "../src/rebalance/dlmm.ts";
import { originalHalfRange } from "../src/rebalance/plan.ts";
import {
	describeZapSwap,
	executeZapRebalance,
	planZapRebalance,
} from "../src/rebalance/zap.ts";

if (!process.argv.includes("--live")) {
	console.error("REFUSING: this script sends REAL transactions.");
	console.error("Usage: bun run scripts/test-rebalance.ts --live");
	process.exit(2);
}

console.log("=== LIVE REBALANCE TRIGGER (zap) ===");
console.log("Real transactions in 5s. Ctrl+C to abort.");
await new Promise((resolve) => setTimeout(resolve, 5000));

loadDotenv();

const main = Effect.gen(function* () {
	const botConfig = yield* loadConfig(process.env);
	const connection = new Connection(botConfig.rpcUrl, "confirmed");
	const signer = Keypair.fromSecretKey(botConfig.secretKey);

	const state = yield* loadPositionState({
		connection,
		poolAddress: botConfig.poolAddress,
		owner: signer.publicKey,
	});
	const snapshot = state.snapshot;
	const halfWidth = originalHalfRange(snapshot.lowerBinId, snapshot.upperBinId);
	console.log(
		`Rebalancing ${snapshot.position} (active ${snapshot.activeBinId}, ` +
			`range ${snapshot.lowerBinId}-${snapshot.upperBinId}) -> ` +
			`${botConfig.strategy} delta -${halfWidth}..+${halfWidth}`,
	);

	const plan = yield* planZapRebalance({
		connection,
		poolAddress: botConfig.poolAddress,
		positionAddress: snapshot.position,
		strategy: botConfig.strategy,
		slippageBps: botConfig.slippageBps,
		halfWidth,
		jupiterApiKey: botConfig.jupiterApiKey,
	});
	const result = plan.estimate.result;
	console.log(
		`Swap: ${describeZapSwap(plan.estimate)} -> ` +
			`X=${result.postSwapX.toString()} Y=${result.postSwapY.toString()}`,
	);

	const done = yield* executeZapRebalance({
		connection,
		signer,
		plan,
	});
	console.log(`Rebalanced via zap: ${done.signature}`);
});

Effect.runPromise(main).then(
	() => process.exit(0),
	(error) => {
		console.error("Live rebalance failed:", error);
		process.exit(1);
	},
);
