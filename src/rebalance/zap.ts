import type {
	DlmmDirectRebalanceEstimate,
	RebalanceDlmmPositionResponse,
	ZapConfig,
} from "@meteora-ag/zap-sdk";
import {
	DlmmSwapType,
	estimateDlmmRebalanceSwap,
	getLbPairState,
	getOrCreateATAInstruction,
	getTokenProgramFromMint,
	Zap,
} from "@meteora-ag/zap-sdk";
import {
	PublicKey,
	Transaction,
	type TransactionInstruction,
} from "@solana/web3.js";
import { Data, Effect } from "effect";
import { AppSigner, SolanaConnection } from "../services.ts";
import { toStrategyType } from "./dlmm.ts";
import type { StrategyKind } from "./plan.ts";
import { nowStamp, sendManualTransaction } from "./send.ts";

export class ZapError extends Data.TaggedError("ZapError")<{
	message: string;
}> {}

export interface ZapPlanInput {
	poolAddress: string;
	positionAddress: string;
	strategy: StrategyKind;
	slippageBps: number;
	halfWidth: number;
	jupiterApiKey?: string;
}

export interface ZapPlan {
	zap: Zap;
	estimate: DlmmDirectRebalanceEstimate;
	minDeltaId: number;
	maxDeltaId: number;
	slippageBps: number;
}

export interface ZapExecuteInput {
	plan: ZapPlan;
}

function toZapError(error: unknown): ZapError {
	return new ZapError({
		message: error instanceof Error ? error.message : String(error),
	});
}

// Same engine the Meteora UI uses: simulate the rebalance off-chain for the
// new delta range, get the exact balancing swap, then build one
// remove -> swap -> zap-in sequence for the existing position.
export const planZapRebalance = Effect.fn("planZapRebalance")(function* (
	input: ZapPlanInput,
): Effect.fn.Return<ZapPlan, ZapError, SolanaConnection> {
	if (
		!Number.isInteger(input.halfWidth) ||
		input.halfWidth < 1 ||
		input.halfWidth > 1024
	) {
		return yield* new ZapError({
			message: `invalid halfWidth: ${input.halfWidth}`,
		});
	}
	const connection = yield* SolanaConnection;
	const zapConfig: ZapConfig = {};
	if (input.jupiterApiKey) {
		zapConfig.jupiterApiKey = input.jupiterApiKey;
	}
	const zap = new Zap(connection, zapConfig);
	const minDeltaId = -input.halfWidth;
	const maxDeltaId = input.halfWidth;
	const estimate = yield* Effect.tryPromise({
		try: () =>
			estimateDlmmRebalanceSwap({
				lbPair: new PublicKey(input.poolAddress),
				position: new PublicKey(input.positionAddress),
				connection,
				swapSlippageBps: input.slippageBps,
				minDeltaId,
				maxDeltaId,
				strategy: toStrategyType(input.strategy),
				config: zapConfig,
			}),
		catch: toZapError,
	});
	return {
		zap,
		estimate,
		minDeltaId,
		maxDeltaId,
		slippageBps: input.slippageBps,
	} satisfies ZapPlan;
});

// The DLMM RebalanceLiquidity instruction requires both user token accounts
// to already exist. A wallet that never held one side has no ATA for it, and
// simulation fails with AccountNotInitialized (3012). The Meteora UI creates
// the missing ATA first — do the same, using the SDK's own helper so
// Token-2022 mints resolve to the right program.
function sendZapTx(
	tx: Transaction,
	label: string,
): Effect.Effect<string, ZapError, SolanaConnection | AppSigner> {
	return Effect.mapError(sendManualTransaction({ tx, label }), (error) =>
		toZapError(error),
	);
}

function ensureUserTokenAccounts(
	lbPair: PublicKey,
): Effect.Effect<void, ZapError, SolanaConnection | AppSigner> {
	return Effect.gen(function* () {
		const connection = yield* SolanaConnection;
		const signer = yield* AppSigner;
		const owner = signer.publicKey;
		const pairState = yield* Effect.tryPromise({
			try: () => getLbPairState(connection, lbPair),
			catch: toZapError,
		});
		const instructions: TransactionInstruction[] = [];
		for (const mint of [pairState.tokenXMint, pairState.tokenYMint]) {
			const tokenProgram = yield* Effect.tryPromise({
				try: () => getTokenProgramFromMint(connection, mint),
				catch: toZapError,
			});
			const { ix } = yield* Effect.tryPromise({
				try: () =>
					getOrCreateATAInstruction(
						connection,
						mint,
						owner,
						owner,
						false,
						tokenProgram,
					),
				catch: toZapError,
			});
			if (ix) {
				instructions.push(ix);
			}
		}
		if (instructions.length === 0) {
			return;
		}
		const signature = yield* sendZapTx(
			new Transaction().add(...instructions),
			"create-atas",
		);
		console.log(
			`[${nowStamp()}] Created ${instructions.length} missing token account(s): ${signature}`,
		);
	});
}

export const executeZapRebalance = Effect.fn("executeZapRebalance")(function* (
	input: ZapExecuteInput,
): Effect.fn.Return<
	{ signature: string },
	ZapError,
	SolanaConnection | AppSigner
> {
	const signer = yield* AppSigner;
	const { zap, estimate } = input.plan;
	yield* ensureUserTokenAccounts(estimate.context.lbPair);
	const response: RebalanceDlmmPositionResponse = yield* Effect.tryPromise({
		try: () =>
			zap.rebalanceDlmmPosition({
				user: signer.publicKey,
				liquiditySlippageBps: input.plan.slippageBps,
				favorXInActiveId: false,
				directSwapEstimate: estimate.result,
				...estimate.context,
			}),
		catch: toZapError,
	});
	console.log(
		`[${nowStamp()}] Zap estimate: current X=${response.estimation.currentBalances.tokenX.toString()} ` +
			`Y=${response.estimation.currentBalances.tokenY.toString()} -> ` +
			`after swap X=${response.estimation.afterSwap.tokenX.toString()} ` +
			`Y=${response.estimation.afterSwap.tokenY.toString()}`,
	);
	const txs: Array<readonly [string, Transaction | null | undefined]> = [
		["setup", response.setupTransaction],
		["init-bin-array", response.initBinArrayTransaction],
		["rebalance-position", response.rebalancePositionTransaction],
		["swap", response.swapTransaction],
		["ledger", response.ledgerTransaction],
		["zap-in", response.zapInTransaction],
		["clean-up", response.cleanUpTransaction],
	];
	let last = "";
	for (const [label, tx] of txs) {
		if (!tx) {
			continue;
		}
		last = yield* sendZapTx(tx, label);
	}
	return { signature: last };
});

export function describeZapSwap(estimate: DlmmDirectRebalanceEstimate): string {
	const result = estimate.result;
	if (result.swapType === DlmmSwapType.NoSwap) {
		return "none";
	}
	const arrow = result.swapType === DlmmSwapType.XToY ? "X -> Y" : "Y -> X";
	return (
		`${arrow} amount=${result.swapAmount.toString()} ` +
		`expectedOut=${result.expectedOutput.toString()}`
	);
}
