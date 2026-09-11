import type DLMM from "@meteora-ag/dlmm";
import type { LbPosition } from "@meteora-ag/dlmm";

import type { Connection, Keypair } from "@solana/web3.js";
import { Effect } from "effect";
import {
	claimFees,
	type DlmmError,
	enterPosition,
	exitPosition,
} from "./dlmm.ts";
import type { RebalancePlan } from "./plan.ts";
import { executeSwapLeg, type SwapError } from "./swap.ts";

export interface ExecuteRebalanceInput {
	connection: Connection;
	dlmm: DLMM;
	signer: Keypair;
	position: LbPosition;
	plan: RebalancePlan;
	slippageBps: number;
	jupiterApiKey?: string;
}

// Live path shared by the bot entry and the manual trigger script.
// Sends real transactions: claim -> exit -> swap -> enter.
export function executeRebalance(
	input: ExecuteRebalanceInput,
): Effect.Effect<{ position: string }, DlmmError | SwapError> {
	const { connection, dlmm, signer, position, plan } = input;
	return Effect.gen(function* () {
		const claimSignatures = yield* claimFees({
			connection,
			dlmm,
			signer,
			position,
		});
		console.log(`Fees claimed in ${claimSignatures.length} tx(s).`);

		const exitSignatures = yield* exitPosition({
			connection,
			dlmm,
			signer,
			position,
		});
		console.log(`Exited position in ${exitSignatures.length} tx(s).`);

		const swapSignature = yield* executeSwapLeg({
			leg: plan.swap,
			taker: signer,
			slippageBps: input.slippageBps,
			apiKey: input.jupiterApiKey,
		});
		if (swapSignature) {
			console.log(`Swap landed: ${swapSignature}`);
		} else {
			console.log("No swap needed.");
		}

		const entered = yield* enterPosition({
			connection,
			dlmm,
			signer,
			totalX: plan.targetX,
			totalY: plan.targetY,
			minBinId: plan.strategy.minBinId,
			maxBinId: plan.strategy.maxBinId,
			strategy: plan.strategy.kind,
		});
		console.log(
			`Opened ${plan.strategy.kind} position ${entered.position}: ${entered.signature}`,
		);
		return { position: entered.position };
	});
}
