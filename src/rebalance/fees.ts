import type DLMM from "@meteora-ag/dlmm";
import type { LbPosition } from "@meteora-ag/dlmm";
import type { Transaction } from "@solana/web3.js";
import { Effect, Ref } from "effect";
import {
	type AppConfig,
	AppSigner,
	RuntimeTunables,
	type SolanaConnection,
} from "../services.ts";
import { formatSig, nowStamp } from "../utils.ts";
import {
	executeReaccumulateToSol,
	type ReaccumulateInput,
} from "./reaccumulate.ts";
import { sendManualTransaction } from "./send.ts";
import {
	type CompoundFeesInput,
	executeCompoundTopUp,
	toZapError,
	type ZapError,
} from "./zap.ts";

export type FeeClaimAction = "sweep" | "compound";

// Reaccumulate wins when both are on, matching executeZapRebalance.
export function feeClaimAction(t: {
	compoundFees: boolean;
	reaccumulateFeesToSol: boolean;
}): FeeClaimAction | null {
	if (t.reaccumulateFeesToSol) {
		return "sweep";
	}
	return t.compoundFees ? "compound" : null;
}

// The DLMM SDK throws this exact message when the position has no fees.
const NO_FEE_TO_CLAIM = "No fee to claim";

// In-range path: claim fees to the wallet, then sweep or compound them the
// way the post-zap path does. Returns null when there was no fee to claim.
export const executeInRangeFeeClaim = Effect.fn("executeInRangeFeeClaim")(
	function* (input: {
		dlmm: DLMM;
		position: LbPosition;
		action: FeeClaimAction;
		compound: CompoundFeesInput;
		reaccumulate: ReaccumulateInput;
	}): Effect.fn.Return<
		{ action: FeeClaimAction; signature: string } | null,
		ZapError,
		SolanaConnection | AppSigner | AppConfig | RuntimeTunables
	> {
		const signer = yield* AppSigner;
		const claimTxs: Transaction[] = yield* Effect.catch(
			Effect.tryPromise({
				try: () =>
					input.dlmm.claimSwapFee({
						owner: signer.publicKey,
						position: input.position,
					}),
				catch: toZapError,
			}),
			(error) =>
				error.message === NO_FEE_TO_CLAIM
					? Effect.succeed([])
					: Effect.fail(error),
		);
		if (claimTxs.length === 0) {
			console.log(`[${nowStamp()}] Fee claim skipped: no fee to claim.`);
			return null;
		}
		const tunablesRef = yield* RuntimeTunables;
		const tunables = yield* Ref.get(tunablesRef);
		let claimSignature = "";
		for (const tx of claimTxs) {
			claimSignature = yield* Effect.mapError(
				sendManualTransaction({
					tx,
					label: "claim-fee",
					priorityLevel: tunables.priorityLevel,
				}),
				(error) => toZapError(error),
			);
			console.log(`[${nowStamp()}] Claimed fees: ${formatSig(claimSignature)}`);
		}
		const actionSignature =
			input.action === "sweep"
				? yield* executeReaccumulateToSol(input.reaccumulate)
				: yield* executeCompoundTopUp(input.compound);
		return {
			action: input.action,
			signature: actionSignature ?? claimSignature,
		};
	},
);
