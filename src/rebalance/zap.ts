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
	type Connection,
	type Keypair,
	PublicKey,
	sendAndConfirmTransaction,
	Transaction,
	type TransactionInstruction,
} from "@solana/web3.js";
import { Data, Effect } from "effect";
import { toStrategyType } from "./dlmm.ts";
import type { StrategyKind } from "./plan.ts";

export class ZapError extends Data.TaggedError("ZapError")<{
	message: string;
}> {}

export interface ZapPlanInput {
	connection: Connection;
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
	connection: Connection;
	signer: Keypair;
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
export function planZapRebalance(
	input: ZapPlanInput,
): Effect.Effect<ZapPlan, ZapError> {
	return Effect.gen(function* () {
		if (
			!Number.isInteger(input.halfWidth) ||
			input.halfWidth < 1 ||
			input.halfWidth > 1024
		) {
			return yield* Effect.fail(
				new ZapError({ message: `invalid halfWidth: ${input.halfWidth}` }),
			);
		}
		const zapConfig: ZapConfig = {};
		if (input.jupiterApiKey) {
			zapConfig.jupiterApiKey = input.jupiterApiKey;
		}
		const zap = new Zap(input.connection, zapConfig);
		const minDeltaId = -input.halfWidth;
		const maxDeltaId = input.halfWidth;
		const estimate = yield* Effect.tryPromise({
			try: () =>
				estimateDlmmRebalanceSwap({
					lbPair: new PublicKey(input.poolAddress),
					position: new PublicKey(input.positionAddress),
					connection: input.connection,
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
}

function sendZapTx(
	connection: Connection,
	tx: Transaction,
	signer: Keypair,
): Effect.Effect<string, ZapError> {
	return Effect.tryPromise({
		try: async () => {
			tx.feePayer = signer.publicKey;
			tx.recentBlockhash = (
				await connection.getLatestBlockhash("confirmed")
			).blockhash;
			return await sendAndConfirmTransaction(connection, tx, [signer]);
		},
		catch: toZapError,
	});
}

// The DLMM RebalanceLiquidity instruction requires both user token accounts
// to already exist. A wallet that never held one side has no ATA for it, and
// simulation fails with AccountNotInitialized (3012). The Meteora UI creates
// the missing ATA first — do the same, using the SDK's own helper so
// Token-2022 mints resolve to the right program.
function ensureUserTokenAccounts(
	connection: Connection,
	signer: Keypair,
	lbPair: PublicKey,
): Effect.Effect<void, ZapError> {
	return Effect.gen(function* () {
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
			connection,
			new Transaction().add(...instructions),
			signer,
		);
		console.log(
			`Created ${instructions.length} missing token account(s): ${signature}`,
		);
	});
}

export function executeZapRebalance(
	input: ZapExecuteInput,
): Effect.Effect<{ signature: string }, ZapError> {
	return Effect.gen(function* () {
		const { zap, estimate } = input.plan;
		yield* ensureUserTokenAccounts(
			input.connection,
			input.signer,
			estimate.context.lbPair,
		);
		const response: RebalanceDlmmPositionResponse = yield* Effect.tryPromise({
			try: () =>
				zap.rebalanceDlmmPosition({
					user: input.signer.publicKey,
					liquiditySlippageBps: input.plan.slippageBps,
					favorXInActiveId: false,
					directSwapEstimate: estimate.result,
					...estimate.context,
				}),
			catch: toZapError,
		});
		console.log(
			`Zap estimate: current X=${response.estimation.currentBalances.tokenX.toString()} ` +
				`Y=${response.estimation.currentBalances.tokenY.toString()} -> ` +
				`after swap X=${response.estimation.afterSwap.tokenX.toString()} ` +
				`Y=${response.estimation.afterSwap.tokenY.toString()}`,
		);
		const txs = [
			response.setupTransaction,
			response.initBinArrayTransaction,
			response.rebalancePositionTransaction,
			response.swapTransaction,
			response.ledgerTransaction,
			response.zapInTransaction,
			response.cleanUpTransaction,
		];
		let last = "";
		for (const tx of txs) {
			if (!tx) {
				continue;
			}
			last = yield* sendZapTx(input.connection, tx, input.signer);
		}
		return { signature: last };
	});
}

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
