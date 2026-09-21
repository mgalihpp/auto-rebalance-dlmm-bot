import {
	buildJupiterSwapTransaction,
	getLbPairState,
	getOrCreateATAInstruction,
	getTokenAccountBalance,
	getTokenProgramFromMint,
	unwrapSOLInstruction,
	type ZapConfig,
} from "@meteora-ag/zap-sdk";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, Transaction } from "@solana/web3.js";
import BN from "bn.js";
import { Effect, Ref } from "effect";
import { AppSigner, RuntimeTunables, SolanaConnection } from "../services.ts";
import { formatSig, nowStamp, shortAddr } from "../utils.ts";
import { SWAP_CU_BUFFER_MULTIPLIER, sendManualTransaction } from "./send.ts";
import { ZapError } from "./zap.ts";

export const WSOL_MINT = "So11111111111111111111111111111111111111112";

export type SweepLegKind = "swap" | "unwrap";

export interface SweepLeg {
	mint: string;
	amount: BN;
	kind: SweepLegKind;
}

export interface ReaccumulateInput {
	enabled: boolean;
	poolAddress: string;
	feeX: BN;
	feeY: BN;
	slippageBps: number;
	jupiterApiKey?: string;
}

// Jupiter routing account cap, same default the zap engine uses when the
// caller does not pin one (rebalanceDlmmPosition defaults maxAccounts to 50).
const SWEEP_JUPITER_MAX_ACCOUNTS = 50;

function toZapError(error: unknown): ZapError {
	return new ZapError({
		message: error instanceof Error ? error.message : String(error),
	});
}

// Each leg is capped by the claimed fee so principal is never touched.
// Both wSOL sides share one ATA (unwrap closes it), so they merge.
export function planSweepLegs(args: {
	feeX: BN;
	feeY: BN;
	balX: BN;
	balY: BN;
	mintX: string;
	mintY: string;
}): SweepLeg[] | null {
	const flooredFeeX = args.feeX.isNeg() ? new BN(0) : args.feeX;
	const flooredFeeY = args.feeY.isNeg() ? new BN(0) : args.feeY;
	const flooredBalX = args.balX.isNeg() ? new BN(0) : args.balX;
	const flooredBalY = args.balY.isNeg() ? new BN(0) : args.balY;
	const x = flooredFeeX.lt(flooredBalX) ? flooredFeeX : flooredBalX;
	const y = flooredFeeY.lt(flooredBalY) ? flooredFeeY : flooredBalY;
	const legs: SweepLeg[] = [];
	if (!x.isZero()) {
		legs.push({
			mint: args.mintX,
			amount: x,
			kind: args.mintX === WSOL_MINT ? "unwrap" : "swap",
		});
	}
	if (!y.isZero()) {
		legs.push({
			mint: args.mintY,
			amount: y,
			kind: args.mintY === WSOL_MINT ? "unwrap" : "swap",
		});
	}
	if (legs.length === 0) {
		return null;
	}
	const unwraps = legs.filter((leg) => leg.kind === "unwrap");
	if (unwraps.length < 2) {
		return legs;
	}
	const total = unwraps.reduce((sum, leg) => sum.add(leg.amount), new BN(0));
	return [
		{ mint: WSOL_MINT, amount: total, kind: "unwrap" },
		...legs.filter((leg) => leg.kind === "swap"),
	];
}

// ensureUserTokenAccounts runs earlier in the zap execute, so the ATA already exists.
function readWalletBalance(
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

function sendSweepTx(
	tx: Transaction,
	label: string,
): Effect.Effect<
	string,
	ZapError,
	SolanaConnection | AppSigner | RuntimeTunables
> {
	return Effect.gen(function* () {
		const tunablesRef = yield* RuntimeTunables;
		const tunables = yield* Ref.get(tunablesRef);
		return yield* Effect.mapError(
			sendManualTransaction({
				tx,
				label,
				priorityLevel: tunables.priorityLevel,
				cuBufferMultiplier: SWAP_CU_BUFFER_MULTIPLIER,
			}),
			(error) => toZapError(error),
		);
	});
}

function executeSweepLeg(
	leg: SweepLeg,
	slippageBps: number,
	jupiterApiKey: string | undefined,
): Effect.Effect<
	string | null,
	ZapError,
	SolanaConnection | AppSigner | RuntimeTunables
> {
	return Effect.gen(function* () {
		const connection = yield* SolanaConnection;
		const signer = yield* AppSigner;
		const user = signer.publicKey;
		const tag = `${shortAddr(leg.mint)}->SOL`;
		if (leg.kind === "unwrap") {
			const unwrapIx = unwrapSOLInstruction(user, user);
			if (!unwrapIx) {
				console.warn(
					`[${nowStamp()}] Sweep leg ${tag} skipped: no wSOL account to unwrap.`,
				);
				return null;
			}
			const signature = yield* sendSweepTx(
				new Transaction().add(unwrapIx),
				`sweep-${tag}`,
			);
			console.log(
				`[${nowStamp()}] Swept ${leg.amount.toString()} ${shortAddr(leg.mint)} to SOL (unwrap): ${formatSig(signature)}`,
			);
			return signature;
		}
		const swapConfig: ZapConfig = {};
		if (jupiterApiKey) {
			swapConfig.jupiterApiKey = jupiterApiKey;
		}
		const built = yield* Effect.catch(
			Effect.tryPromise({
				try: () =>
					buildJupiterSwapTransaction(
						user,
						new PublicKey(leg.mint),
						new PublicKey(WSOL_MINT),
						leg.amount,
						SWEEP_JUPITER_MAX_ACCOUNTS,
						slippageBps,
						undefined,
						swapConfig,
					),
				catch: toZapError,
			}),
			(error) =>
				Effect.sync(() => {
					console.warn(
						`[${nowStamp()}] Sweep leg ${tag} skipped: Jupiter quote failed (${error.message}).`,
					);
					return null;
				}),
		);
		if (built === null) {
			return null;
		}
		// wSOL is the native mint on the standard token program (same as the
		// SDK's own unwrap path), so no program lookup is needed here.
		const { ix: wsolIx } = yield* Effect.tryPromise({
			try: () =>
				getOrCreateATAInstruction(
					connection,
					new PublicKey(WSOL_MINT),
					user,
					user,
					false,
					TOKEN_PROGRAM_ID,
				),
			catch: toZapError,
		});
		const tx = new Transaction();
		if (wsolIx) {
			tx.add(wsolIx);
		}
		for (const ix of built.transaction.instructions) {
			tx.add(ix);
		}
		const unwrapIx = unwrapSOLInstruction(user, user);
		if (unwrapIx) {
			tx.add(unwrapIx);
		}
		const signature = yield* sendSweepTx(tx, `sweep-${tag}`);
		console.log(
			`[${nowStamp()}] Swept ${leg.amount.toString()} ${shortAddr(leg.mint)} to SOL (swap): ${formatSig(signature)}`,
		);
		return signature;
	});
}

// No separate claim — the zap already claimed fees to the user ATAs.
export const executeReaccumulateToSol = Effect.fn("executeReaccumulateToSol")(
	function* (
		input: ReaccumulateInput,
	): Effect.fn.Return<
		string | null,
		ZapError,
		SolanaConnection | AppSigner | RuntimeTunables
	> {
		if (!input.enabled) {
			return null;
		}
		const zero = new BN(0);
		if (input.feeX.lte(zero) && input.feeY.lte(zero)) {
			console.log(
				`[${nowStamp()}] Reaccumulate to SOL skipped: no claimable fees.`,
			);
			return null;
		}
		const connection = yield* SolanaConnection;
		const lbPair = yield* Effect.try({
			try: () => new PublicKey(input.poolAddress),
			catch: (error) => toZapError(error),
		});
		const pairState = yield* Effect.tryPromise({
			try: () => getLbPairState(connection, lbPair),
			catch: toZapError,
		});
		const balX = yield* readWalletBalance(pairState.tokenXMint);
		const balY = yield* readWalletBalance(pairState.tokenYMint);
		const legs = planSweepLegs({
			feeX: input.feeX,
			feeY: input.feeY,
			balX,
			balY,
			mintX: pairState.tokenXMint.toBase58(),
			mintY: pairState.tokenYMint.toBase58(),
		});
		if (legs === null) {
			console.log(
				`[${nowStamp()}] Reaccumulate to SOL skipped: wallet balance covers none of the claimed fees.`,
			);
			return null;
		}
		// Unwrap legs run before swap legs: every swap transaction ends by
		// closing the wSOL ATA, so a standalone unwrap must land first.
		const ordered = [
			...legs.filter((leg) => leg.kind === "unwrap"),
			...legs.filter((leg) => leg.kind === "swap"),
		];
		let last: string | null = null;
		for (const leg of ordered) {
			const signature = yield* executeSweepLeg(
				leg,
				input.slippageBps,
				input.jupiterApiKey,
			);
			if (signature !== null) {
				last = signature;
			}
		}
		return last;
	},
);
