// LIVE rebalance trigger. Sends REAL transactions against the pool in .env:
// claim -> exit -> swap -> enter. No drift gate, no dry-run, no index.ts.
//
// Usage: bun run scripts/test-rebalance.ts --live
// Without --live this script exits immediately without touching RPC.
import { Connection, Keypair } from "@solana/web3.js";
import { config as loadDotenv } from "dotenv";
import { Effect } from "effect";
import { loadConfig } from "../src/config.ts";
import { loadPositionState } from "../src/rebalance/dlmm.ts";
import { executeRebalance } from "../src/rebalance/execute.ts";
import { buildRebalancePlan } from "../src/rebalance/plan.ts";

if (!process.argv.includes("--live")) {
	console.error("REFUSING: this script sends REAL transactions.");
	console.error("Usage: bun run scripts/test-rebalance.ts --live");
	process.exit(2);
}

console.log("=== LIVE REBALANCE TRIGGER ===");
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
	console.log(
		`Rebalancing ${snapshot.position} (active ${snapshot.activeBinId}, ` +
			`range ${snapshot.lowerBinId}-${snapshot.upperBinId}) -> ` +
			`${botConfig.strategy} compound=${botConfig.compoundFees}`,
	);

	const plan = yield* buildRebalancePlan(snapshot, {
		slippageBps: botConfig.slippageBps,
		compoundFees: botConfig.compoundFees,
		strategy: botConfig.strategy,
	});

	yield* executeRebalance({
		connection,
		dlmm: state.dlmm,
		signer,
		position: state.position,
		plan,
		slippageBps: botConfig.slippageBps,
		jupiterApiKey: botConfig.jupiterApiKey,
	});
});

Effect.runPromise(main).then(
	() => process.exit(0),
	(error) => {
		console.error("Live rebalance failed:", error);
		process.exit(1);
	},
);
