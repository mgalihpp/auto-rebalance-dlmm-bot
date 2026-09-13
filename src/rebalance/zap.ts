import type DLMM from "@meteora-ag/dlmm";
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
	getTokenAccountBalance,
	getTokenProgramFromMint,
	Zap,
} from "@meteora-ag/zap-sdk";
import {
	PublicKey,
	Transaction,
	type TransactionInstruction,
} from "@solana/web3.js";
import BN from "bn.js";
import { Data, Effect } from "effect";
import { AppConfig, AppSigner, SolanaConnection } from "../services.ts";
import { formatSig, nowStamp } from "../utils.ts";
import { sendManualTransaction } from "./send.ts";
import { type StrategyKind, toStrategyType } from "./types.ts";

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
	compound: CompoundFeesInput;
}

// Opt-in redeposit of the fees the zap claims to the user ATAs. The zap
// sizes its swap from position liquidity only, so claimed fees sit in the
// wallet after a rebalance unless this top-up deposits them back.
export interface CompoundFeesInput {
	enabled: boolean;
	dlmm: DLMM;
	positionAddress: string;
	feeX: BN;
	feeY: BN;
	minBinId: number;
	maxBinId: number;
	strategy: StrategyKind;
	slippageBps: number;
}

// Pure cap: each leg deposits at most the claimed fee and at most the wallet
// balance. Negatives count as zero; null means there is nothing to deposit.
export function compoundTopUpAmounts(
	feeX: BN,
	feeY: BN,
	balX: BN,
	balY: BN,
): { x: BN; y: BN } | null {
	const flooredFeeX = feeX.isNeg() ? new BN(0) : feeX;
	const flooredFeeY = feeY.isNeg() ? new BN(0) : feeY;
	const flooredBalX = balX.isNeg() ? new BN(0) : balX;
	const flooredBalY = balY.isNeg() ? new BN(0) : balY;
	const x = flooredFeeX.lt(flooredBalX) ? flooredFeeX : flooredBalX;
	const y = flooredFeeY.lt(flooredBalY) ? flooredFeeY : flooredBalY;
	if (x.isZero() && y.isZero()) {
		return null;
	}
	return { x, y };
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
): Effect.Effect<string, ZapError, SolanaConnection | AppSigner | AppConfig> {
	return Effect.gen(function* () {
		const config = yield* AppConfig;
		return yield* Effect.mapError(
			sendManualTransaction({
				tx,
				label,
				priorityLevel: config.priorityLevel,
			}),
			(error) => toZapError(error),
		);
	});
}

function ensureUserTokenAccounts(
	lbPair: PublicKey,
): Effect.Effect<void, ZapError, SolanaConnection | AppSigner | AppConfig> {
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
			`[${nowStamp()}] Created ${instructions.length} missing token account(s): ${formatSig(signature)}`,
		);
	});
}

// Wallet balance of one side's ATA. ensureUserTokenAccounts runs earlier in
// the same execute, so the ATA already exists and the helper's `ix` is null.
function readAtaBalance(
	mint: PublicKey,
): Effect.Effect<BN, ZapError, SolanaConnection | AppSigner> {
	return Effect.gen(function* () {
		const connection = yield* SolanaConnection;
		const signer = yield* AppSigner;
		const tokenProgram = yield* Effect.tryPromise({
			try: () => getTokenProgramFromMint(connection, mint),
			catch: toZapError,
		});
		const { ataPubkey } = yield* Effect.tryPromise({
			try: () =>
				getOrCreateATAInstruction(
					connection,
					mint,
					signer.publicKey,
					signer.publicKey,
					false,
					tokenProgram,
				),
			catch: toZapError,
		});
		const raw = yield* Effect.tryPromise({
			try: () => getTokenAccountBalance(connection, ataPubkey),
			catch: toZapError,
		});
		return yield* Effect.try({
			try: () => new BN(raw),
			catch: (error) => toZapError(error),
		});
	});
}

// Conditional post-zap step: deposit the claimed fees back into the new
// range. Returns the top-up signature, or null when skipped.
function executeCompoundTopUp(
	input: CompoundFeesInput,
): Effect.Effect<
	string | null,
	ZapError,
	SolanaConnection | AppSigner | AppConfig
> {
	return Effect.gen(function* () {
		if (!input.enabled) {
			return null;
		}
		const zero = new BN(0);
		if (input.feeX.lte(zero) && input.feeY.lte(zero)) {
			console.log(`[${nowStamp()}] Compound fees skipped: no claimable fees.`);
			return null;
		}
		const connection = yield* SolanaConnection;
		const signer = yield* AppSigner;
		const pairState = yield* Effect.tryPromise({
			try: () => getLbPairState(connection, input.dlmm.pubkey),
			catch: toZapError,
		});
		const balX = yield* readAtaBalance(pairState.tokenXMint);
		const balY = yield* readAtaBalance(pairState.tokenYMint);
		const amounts = compoundTopUpAmounts(input.feeX, input.feeY, balX, balY);
		if (amounts === null) {
			console.log(
				`[${nowStamp()}] Compound fees skipped: wallet balance covers none of the claimed fees.`,
			);
			return null;
		}
		// DLMM add-liquidity slippage is a percentage (0-100), not bps: the
		// SDK caps it at 100 and scales it by bin step.
		const tx = yield* Effect.tryPromise({
			try: () =>
				input.dlmm.addLiquidityByStrategy({
					positionPubKey: new PublicKey(input.positionAddress),
					totalXAmount: amounts.x,
					totalYAmount: amounts.y,
					strategy: {
						minBinId: input.minBinId,
						maxBinId: input.maxBinId,
						strategyType: toStrategyType(input.strategy),
					},
					user: signer.publicKey,
					slippage: input.slippageBps / 100,
				}),
			catch: toZapError,
		});
		const signature = yield* sendZapTx(tx, "compound-fees");
		console.log(
			`[${nowStamp()}] Compounded fees: X=${amounts.x.toString()} Y=${amounts.y.toString()}: ${formatSig(signature)}`,
		);
		return signature;
	});
}

export const executeZapRebalance = Effect.fn("executeZapRebalance")(function* (
	input: ZapExecuteInput,
): Effect.fn.Return<
	{ signature: string },
	ZapError,
	SolanaConnection | AppSigner | AppConfig
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
		`[${nowStamp()}] Zap estimate: current balances X=${response.estimation.currentBalances.tokenX.toString()} ` +
			`Y=${response.estimation.currentBalances.tokenY.toString()} | ` +
			`after-swap balances X=${response.estimation.afterSwap.tokenX.toString()} ` +
			`Y=${response.estimation.afterSwap.tokenY.toString()} | ` +
			`swap ${describeZapSwap(estimate)}`,
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
	const topUp = yield* executeCompoundTopUp(input.compound);
	return { signature: topUp ?? last };
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
