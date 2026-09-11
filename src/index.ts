import { Connection, Keypair } from "@solana/web3.js";
import type BN from "bn.js";
import Decimal from "decimal.js";
import { config as loadDotenv } from "dotenv";
import { Effect } from "effect";
import { loadConfig } from "./config.ts";
import { loadPositionState } from "./rebalance/dlmm.ts";
import { executeRebalance } from "./rebalance/execute.ts";
import {
	buildRebalancePlan,
	type RebalancePlan,
	shouldRebalance,
} from "./rebalance/plan.ts";

loadDotenv();

function formatBn(value: BN): string {
	return new Decimal(value.toString()).toFixed(0);
}

function describeSwap(plan: RebalancePlan): string {
	if (plan.swap.direction === "None") {
		return "none";
	}
	const arrow = plan.swap.direction === "XtoY" ? "X -> Y" : "Y -> X";
	return `${arrow} amount=${formatBn(plan.swap.inAmount)} minOut=${formatBn(plan.swap.minOutAmount)} (Jupiter)`;
}

function printPreview(
	plan: RebalancePlan,
	snapshot: { lowerBinId: number; upperBinId: number },
) {
	const width = snapshot.upperBinId - snapshot.lowerBinId;
	console.log("=== DLMM auto-rebalance preview ===");
	console.log(`Pool:            ${plan.pool}`);
	console.log(`Position:        ${plan.position}`);
	console.log(`Active bin:      ${plan.activeBinId}`);
	console.log(
		`Current range:   ${snapshot.lowerBinId} - ${snapshot.upperBinId}`,
	);
	console.log(
		`Range: original ${snapshot.lowerBinId}-${snapshot.upperBinId} (width ${width}) -> ` +
			`new ${plan.strategy.minBinId}-${plan.strategy.maxBinId}`,
	);
	console.log(
		`Current:         X=${formatBn(plan.currentX)} Y=${formatBn(plan.currentY)}`,
	);
	console.log(
		`Rebalanced:      X=${formatBn(plan.targetX)} Y=${formatBn(plan.targetY)} ` +
			`(${plan.strategy.kind} ${plan.strategy.minBinId} - ${plan.strategy.maxBinId})`,
	);
	console.log(`Swaps required:  ${describeSwap(plan)}`);
	console.log(
		`Fees claimed:    X=${formatBn(plan.claimedFeeX)} Y=${formatBn(plan.claimedFeeY)} (lifetime)`,
	);
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

const botConfig = await Effect.runPromise(loadConfig(process.env)).catch(
	(error): never => {
		console.error("Rebalance failed:", error);
		process.exit(1);
	},
);
const connection = new Connection(botConfig.rpcUrl, "confirmed");
const signer = Keypair.fromSecretKey(botConfig.secretKey);

function runIteration() {
	return Effect.gen(function* () {
		const state = yield* loadPositionState({
			connection,
			poolAddress: botConfig.poolAddress,
			owner: signer.publicKey,
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

		const plan = yield* buildRebalancePlan(snapshot, {
			slippageBps: botConfig.slippageBps,
			compoundFees: botConfig.compoundFees,
			strategy: botConfig.strategy,
		});
		printPreview(plan, {
			lowerBinId: snapshot.lowerBinId,
			upperBinId: snapshot.upperBinId,
		});
		if (!botConfig.compoundFees) {
			console.log("Fees: excluded from redeposit (COMPOUND_FEES=false)");
		}

		if (botConfig.dryRun) {
			console.log("Dry run — no transactions sent.");
			return;
		}

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
}

while (!stopped) {
	try {
		await Effect.runPromise(runIteration());
	} catch (error) {
		console.error("Rebalance failed:", error);
	}
	if (stopped) {
		break;
	}
	await new Promise<void>((resolve) => {
		wake = resolve;
		setTimeout(resolve, botConfig.pollIntervalMs);
	});
	wake = undefined;
}
