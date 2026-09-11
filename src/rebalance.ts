import type { StrategyType } from "@meteora-ag/dlmm";
import {
	createAssociatedTokenAccountInstruction,
	createSyncNativeInstruction,
	getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
	type Connection,
	type Keypair,
	PublicKey,
	SystemProgram,
	Transaction,
	type TransactionInstruction,
	VersionedTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import { Effect } from "effect";
import type { BotConfig } from "./config.ts";
import type {
	LiquidityStrategy,
	PositionSnapshot,
	RebalancePlan,
} from "./decision.ts";
import {
	DlmmError,
	type RebalanceContext,
	sdkStrategyOf,
	slippagePct,
} from "./dlmm.ts";
import type { BundleLeg, BundleStatus, JitoError } from "./jito.ts";
import {
	assertBundlePlan,
	getTipAccounts,
	pickTipAccount,
	pollBundleStatus,
	sendBundle as sendJitoBundle,
	simulateBundle as simulateJitoBundle,
} from "./jito.ts";
import { formatDryRunBox, log, paint, txLink } from "./log.ts";
import {
	executeJupiterOrder,
	getJupiterOrder,
	type SwapError,
	signJupiterOrder,
} from "./swap.ts";

export const involvesSolMint = (mintX: string, mintY: string): boolean =>
	mintX === NATIVE_MINT || mintY === NATIVE_MINT;

export type SwapDirection =
	| { readonly kind: "none" }
	| {
			readonly kind: "swap";
			readonly inputMint: string;
			readonly outputMint: string;
			readonly inAmount: string;
			readonly outAmountMin: string;
	  };

export interface BalancedPlan {
	readonly lowerBinId: number;
	readonly upperBinId: number;
	readonly strategy: LiquidityStrategy;
	readonly depositX: string;
	readonly depositY: string;
	readonly swap: SwapDirection;
}

export interface BalancedPlanInputs {
	readonly activeBinId: number;
	readonly widthBins: number;
	readonly strategy: LiquidityStrategy;
	readonly tokenXMint: string;
	readonly tokenYMint: string;
	readonly withdrawnX: string;
	readonly withdrawnY: string;
	readonly activePrice: string;
	readonly slippageBps: number;
}

// why: in-place rebalance keeps the same position account alive. The SDK
// withdraws everything on the old range (a no-op once emptied) and deposits
// purely from topUp, so a full haircut means zero redeposit from the position.
const FULL_HAIRCUT_BPS = 10000;
const MIN_WIDTH_BINS = 3;
const REBALANCE_ACTIVE_BIN_SLIPPAGE = 3;
const NATIVE_MINT = "So11111111111111111111111111111111111111112";

type SimulateResponse = Awaited<
	ReturnType<
		RebalanceContext["dlmm"]["simulateRebalancePositionWithBalancedStrategy"]
	>
>;

const dlmmFail = (msg: string): Effect.Effect<never, DlmmError> =>
	Effect.fail(new DlmmError(msg));

const mustBaseUnit = (raw: string, name: string): BN => {
	if (!/^\d+$/.test(raw))
		throw new DlmmError(`${name} is not a base-unit amount: "${raw}"`);
	return new BN(raw);
};

export const addBaseUnits = (a: string, b: string): string =>
	mustBaseUnit(a, "amount").add(mustBaseUnit(b, "amount")).toString();

// why: COMPOUND_FEES=false leaves web-style fees claimed in the wallet, so the
// topUp derived from the wallet delta must exclude them, floored at zero.
export const excludeFees = (
	deltaBaseUnit: string,
	feeBaseUnit: string,
): string => {
	const delta = mustBaseUnit(deltaBaseUnit, "delta");
	const fee = mustBaseUnit(feeBaseUnit, "fee");
	const rest = delta.sub(fee);
	return (rest.isNeg() ? new BN(0) : rest).toString();
};

// why: wallet dust predates the withdraw, so the live topUp is the post-swap
// balance minus the pre-withdraw snapshot, floored at zero for lamport fees.
export const deriveTopUp = (args: {
	readonly beforeX: string;
	readonly afterX: string;
	readonly beforeY: string;
	readonly afterY: string;
}): { readonly topUpX: string; readonly topUpY: string } => {
	const diff = (before: string, after: string): string => {
		const d = mustBaseUnit(after, "walletAfter").sub(
			mustBaseUnit(before, "walletBefore"),
		);
		return (d.isNeg() ? new BN(0) : d).toString();
	};
	return {
		topUpX: diff(args.beforeX, args.afterX),
		topUpY: diff(args.beforeY, args.afterY),
	};
};

export interface WalletSnapshot {
	readonly x: string;
	readonly y: string;
	readonly sol: string;
}

export const capTopUpToBalances = (args: {
	readonly topUpX: string;
	readonly topUpY: string;
	readonly balanceX: string;
	readonly balanceY: string;
}): { readonly topUpX: string; readonly topUpY: string } => {
	if (
		mustBaseUnit(args.topUpX, "topUpX").gt(
			mustBaseUnit(args.balanceX, "balanceX"),
		) ||
		mustBaseUnit(args.topUpY, "topUpY").gt(
			mustBaseUnit(args.balanceY, "balanceY"),
		)
	) {
		throw new DlmmError(
			`topUp ${args.topUpX}/${args.topUpY} exceeds ATA balances ` +
				`${args.balanceX}/${args.balanceY}, abort rebalance`,
		);
	}
	return { topUpX: args.topUpX, topUpY: args.topUpY };
};

export interface ClaimedFees {
	readonly feeX: string;
	readonly feeY: string;
}

// why: recovery sizes from the wallet delta (current minus pre-withdraw
// snapshot) instead of position totals, so dust cancels out.
export const sizeFromWalletDelta = (args: {
	readonly deltaX: string;
	readonly deltaY: string;
	readonly feeX: string;
	readonly feeY: string;
	readonly compoundFees: boolean;
}): { readonly sizedX: string; readonly sizedY: string } => ({
	sizedX: args.compoundFees ? args.deltaX : excludeFees(args.deltaX, args.feeX),
	sizedY: args.compoundFees ? args.deltaY : excludeFees(args.deltaY, args.feeY),
});

// why: /execute may omit totals, so fall back to the order outAmount.
export const actualSwapOut = (totalOut: string, orderOut: string): string =>
	/^\d+$/.test(totalOut) && totalOut !== "0" ? totalOut : orderOut;

// why: width must survive snapshots taken while untracked, so fall back to a
// minimal centered window instead of refusing to plan.
export const resolveWidth = (
	snapshotLower: number | null,
	snapshotUpper: number | null,
	override: number | null,
): number => {
	if (override !== null && override >= 1) return Math.floor(override);
	if (
		snapshotLower !== null &&
		snapshotUpper !== null &&
		snapshotUpper >= snapshotLower
	) {
		return snapshotUpper - snapshotLower + 1;
	}
	return MIN_WIDTH_BINS;
};

export const centerRange = (
	activeBinId: number,
	widthBins: number,
): { readonly lowerBinId: number; readonly upperBinId: number } => {
	const width = Math.max(1, Math.floor(widthBins));
	const lowerBinId = activeBinId - Math.floor(width / 2);
	return { lowerBinId, upperBinId: lowerBinId + width - 1 };
};

const parsePriceFraction = (
	price: string,
): { readonly num: BN; readonly den: BN } => {
	const m = price.trim().match(/^(\d+)(?:\.(\d+))?$/);
	if (!m) throw new DlmmError(`active bin price is not numeric: "${price}"`);
	const frac = m[2] ?? "";
	const num = new BN(`${m[1]}${frac}` || "0");
	const den = new BN(10).pow(new BN(frac.length));
	if (num.isZero()) throw new DlmmError(`active bin price is zero: "${price}"`);
	return { num, den };
};

// why: strategies differ in per-bin weights, not in total X/Y value ratio, so a
// 50/50 value split at the active price deposits both sides for any centered range.
export const computeBalancedPlan = (
	inputs: BalancedPlanInputs,
): Effect.Effect<BalancedPlan, DlmmError> =>
	Effect.try({
		try: (): BalancedPlan => {
			const x = mustBaseUnit(inputs.withdrawnX, "withdrawnX");
			const y = mustBaseUnit(inputs.withdrawnY, "withdrawnY");
			if (x.isZero() && y.isZero())
				throw new DlmmError("nothing withdrawn, cannot plan rebalance");
			const { lowerBinId, upperBinId } = centerRange(
				inputs.activeBinId,
				inputs.widthBins,
			);
			const { num, den } = parsePriceFraction(inputs.activePrice);
			const valueX = x.mul(num).div(den);
			const half = valueX.add(y).div(new BN(2));
			const slip = Math.min(Math.max(inputs.slippageBps, 0), 10000);
			const minFactor = new BN(10000 - slip);
			const base = {
				lowerBinId,
				upperBinId,
				strategy: inputs.strategy,
			} as const;
			if (valueX.gt(half)) {
				const excess = valueX.sub(half);
				const inAmount = excess.mul(den).div(num);
				if (inAmount.isZero()) {
					return {
						...base,
						depositX: x.toString(),
						depositY: y.toString(),
						swap: { kind: "none" },
					};
				}
				const outMin = excess.mul(minFactor).div(new BN(10000));
				return {
					...base,
					depositX: x.sub(inAmount).toString(),
					depositY: y.add(excess).toString(),
					swap: {
						kind: "swap",
						inputMint: inputs.tokenXMint,
						outputMint: inputs.tokenYMint,
						inAmount: inAmount.toString(),
						outAmountMin: outMin.toString(),
					},
				};
			}
			if (half.gt(valueX)) {
				const need = half.sub(valueX);
				if (need.isZero()) {
					return {
						...base,
						depositX: x.toString(),
						depositY: y.toString(),
						swap: { kind: "none" },
					};
				}
				const expectedOut = need.mul(den).div(num);
				const outMin = expectedOut.mul(minFactor).div(new BN(10000));
				return {
					...base,
					depositX: x.add(expectedOut).toString(),
					depositY: y.sub(need).toString(),
					swap: {
						kind: "swap",
						inputMint: inputs.tokenYMint,
						outputMint: inputs.tokenXMint,
						inAmount: need.toString(),
						outAmountMin: outMin.toString(),
					},
				};
			}
			return {
				...base,
				depositX: x.toString(),
				depositY: y.toString(),
				swap: { kind: "none" },
			};
		},
		catch: (e) =>
			e instanceof DlmmError
				? e
				: new DlmmError(
						`computeBalancedPlan failed: ${e instanceof Error ? e.message : String(e)}`,
					),
	});

const sendLegacy = async (
	connection: Connection,
	owner: Keypair,
	tx: Transaction,
	signers: Keypair[],
): Promise<string> => {
	const { blockhash, lastValidBlockHeight } =
		await connection.getLatestBlockhash("confirmed");
	tx.feePayer = owner.publicKey;
	tx.recentBlockhash = blockhash;
	tx.lastValidBlockHeight = lastValidBlockHeight;
	const sig = await connection.sendTransaction(tx, signers, {
		skipPreflight: false,
	});
	const res = await connection.confirmTransaction(
		{ signature: sig, blockhash, lastValidBlockHeight },
		"confirmed",
	);
	if (res.value.err)
		throw new Error(
			`transaction failed: ${sig} err=${JSON.stringify(res.value.err)}`,
		);
	return sig;
};

const sendInstructions = async (
	connection: Connection,
	owner: Keypair,
	ixs: readonly TransactionInstruction[],
): Promise<string> => {
	const tx = new Transaction().add(...ixs);
	return sendLegacy(connection, owner, tx, [owner]);
};

const swapErrToDlmm = (e: SwapError): DlmmError =>
	new DlmmError(`jupiter: ${e.message}`);

// why: balances are ALWAYS Associated Token Account only. Native SOL is gas
// money and must never enter sizing or topUp: removeLiquidity unwraps wSOL
// to native, so the SOL leg is explicitly wrapped (minus reserve) into wSOL
// before any read. Counting native directly once swept the whole gas balance
// into a swap + deposit.
const walletBalanceOf = async (
	connection: Connection,
	owner: PublicKey,
	mint: PublicKey,
): Promise<BN> => {
	const res = await connection.getParsedTokenAccountsByOwner(owner, { mint });
	let total = new BN(0);
	for (const { account } of res.value) {
		const data = account.data as unknown as {
			readonly parsed?: {
				readonly info?: {
					readonly tokenAmount?: { readonly amount?: unknown };
				};
			};
		};
		const amount = data.parsed?.info?.tokenAmount?.amount;
		if (typeof amount === "string" && /^\d+$/.test(amount)) {
			total = total.add(new BN(amount));
		}
	}
	return total;
};

const readWalletLeg = (
	connection: Connection,
	owner: PublicKey,
	mint: PublicKey,
	side: "X" | "Y",
	verb: "read" | "re-read",
): Effect.Effect<BN, DlmmError> =>
	Effect.tryPromise({
		try: () => walletBalanceOf(connection, owner, mint),
		catch: (e) =>
			new DlmmError(
				`wallet ${side} ${verb} failed: ${e instanceof Error ? e.message : String(e)}`,
			),
	});

export const wrapAmountAboveFloor = (args: {
	readonly nativeLamports: string;
	readonly floorLamports: string;
}): string => {
	const over = mustBaseUnit(args.nativeLamports, "native").sub(
		mustBaseUnit(args.floorLamports, "floor"),
	);
	return over.isNeg() || over.isZero() ? "0" : over.toString();
};

const TX_FEE_BUFFER_LAMPORTS = 1_000_000;

const wrapSolLeg = (
	connection: Connection,
	owner: Keypair,
	floorLamports: number,
	reserveLamports: number,
): Effect.Effect<void, DlmmError> =>
	Effect.gen(function* () {
		const native = yield* Effect.tryPromise({
			try: () => connection.getBalance(owner.publicKey),
			catch: (e) =>
				new DlmmError(
					`native SOL read failed: ${e instanceof Error ? e.message : String(e)}`,
				),
		});
		if (native < reserveLamports) {
			return yield* dlmmFail(
				`native SOL ${(native / 1e9).toFixed(6)} below reserve ` +
					`${(reserveLamports / 1e9).toFixed(6)}: top up gas, abort rebalance`,
			);
		}
		const amount = wrapAmountAboveFloor({
			nativeLamports: String(native),
			floorLamports: String(floorLamports),
		});
		if (amount === "0") {
			yield* Effect.sync(() =>
				log(
					"LIVE",
					`wrap skipped, native ${(native / 1e9).toFixed(6)} at floor, ` +
						`proceeds none`,
				),
			);
			return;
		}
		const wsolAta = getAssociatedTokenAddressSync(
			new PublicKey(NATIVE_MINT),
			owner.publicKey,
		);
		const sig = yield* Effect.tryPromise({
			try: async () => {
				const ata = await connection.getAccountInfo(wsolAta);
				const ixs: TransactionInstruction[] = [];
				if (!ata) {
					ixs.push(
						createAssociatedTokenAccountInstruction(
							owner.publicKey,
							wsolAta,
							owner.publicKey,
							new PublicKey(NATIVE_MINT),
						),
					);
				}
				ixs.push(
					SystemProgram.transfer({
						fromPubkey: owner.publicKey,
						toPubkey: wsolAta,
						lamports: BigInt(amount),
					}),
					createSyncNativeInstruction(wsolAta),
				);
				return sendInstructions(connection, owner, ixs);
			},
			catch: (e) =>
				new DlmmError(
					`wrap SOL failed: ${e instanceof Error ? e.message : String(e)}`,
				),
		});
		yield* Effect.sync(() =>
			log(
				"LIVE",
				`wrap ${(Number(amount) / 1e9).toFixed(6)} SOL -> wSOL, floor ` +
					`${(floorLamports / 1e9).toFixed(6)} SOL untouched ${sig} ${txLink(sig)}`,
			),
		);
	});

const toNum = (v: number | BN): number =>
	typeof v === "number" ? v : v.toNumber();

// why: the SDK centers the deposit on the live active bin, so show that
// true range instead of the manual guess.
const simulatedRange = (
	response: SimulateResponse,
	fallback: { readonly lowerBinId: number; readonly upperBinId: number },
): { readonly lowerBinId: number; readonly upperBinId: number } => {
	const first = response.simulationResult.depositParams[0];
	if (!first) return fallback;
	const activeId = Number(response.rebalancePosition.lbPair.activeId);
	return {
		lowerBinId: activeId + toNum(first.minDeltaId),
		upperBinId: activeId + toNum(first.maxDeltaId),
	};
};

export interface PreviewedBalancedPlan extends BalancedPlan {
	readonly feeX: string;
	readonly feeY: string;
}

export const previewBalancedPlan = (args: {
	readonly dlmm: RebalanceContext["dlmm"];
	readonly config: BotConfig;
	readonly snapshot: PositionSnapshot;
}): Effect.Effect<PreviewedBalancedPlan, DlmmError> =>
	Effect.gen(function* () {
		const { dlmm, config, snapshot } = args;
		if (snapshot.status === "Error")
			return yield* dlmmFail("snapshot error, cannot preview rebalance plan");
		if (!config.positionPubkey)
			return yield* dlmmFail(
				"POSITION_PUBKEY missing, cannot preview rebalance plan",
			);
		const position = new PublicKey(config.positionPubkey);
		const { positionData } = yield* Effect.tryPromise({
			try: () => dlmm.getPosition(position),
			catch: (e) =>
				new DlmmError(
					`preview getPosition failed: ${e instanceof Error ? e.message : String(e)}`,
				),
		});
		const active = yield* Effect.tryPromise({
			try: () => dlmm.getActiveBin(),
			catch: (e) =>
				new DlmmError(
					`preview getActiveBin failed: ${e instanceof Error ? e.message : String(e)}`,
				),
		});
		const feeX = positionData.feeX.toString();
		const feeY = positionData.feeY.toString();
		const guessed = yield* computeBalancedPlan({
			activeBinId: snapshot.activeBinId,
			widthBins: resolveWidth(
				snapshot.lowerBinId,
				snapshot.upperBinId,
				config.positionWidthBins,
			),
			strategy: config.strategy,
			tokenXMint: dlmm.tokenX.publicKey.toBase58(),
			tokenYMint: dlmm.tokenY.publicKey.toBase58(),
			withdrawnX: config.compoundFees
				? addBaseUnits(positionData.totalXAmount, feeX)
				: positionData.totalXAmount,
			withdrawnY: config.compoundFees
				? addBaseUnits(positionData.totalYAmount, feeY)
				: positionData.totalYAmount,
			activePrice: active.price,
			slippageBps: config.swapSlippageBps,
		});
		const withFees = { ...guessed, feeX, feeY };
		const simulated = yield* Effect.tryPromise({
			try: () =>
				dlmm.simulateRebalancePositionWithBalancedStrategy(
					position,
					positionData,
					sdkStrategyOf(config.strategy),
					new BN(guessed.depositX),
					new BN(guessed.depositY),
					new BN(FULL_HAIRCUT_BPS),
					new BN(FULL_HAIRCUT_BPS),
				),
			catch: (e) =>
				new DlmmError(
					`preview simulate failed: ${e instanceof Error ? e.message : String(e)}`,
				),
		}).pipe(
			Effect.catch((e) =>
				Effect.sync(() =>
					log("WARN", `preview simulate failed, using guessed range: ${e}`),
				).pipe(Effect.as(null as SimulateResponse | null)),
			),
		);
		if (!simulated) return withFees;
		const range = simulatedRange(simulated, guessed);
		return { ...withFees, ...range };
	});

export interface DryRunDecimals {
	readonly tokenXMint: string;
	readonly tokenYMint: string;
	readonly decimalsX: number;
	readonly decimalsY: number;
}

export interface DryRunFees {
	readonly feeX: string;
	readonly feeY: string;
}

export const logDryRunBalancedPlan = (
	snapshot: PositionSnapshot,
	plan: BalancedPlan,
	meta: DryRunDecimals,
	fees?: DryRunFees,
): Effect.Effect<void> =>
	Effect.sync(() => {
		const swap =
			plan.swap.kind === "none"
				? ({ kind: "none" } as const)
				: {
						kind: "swap" as const,
						inAmount: plan.swap.inAmount,
						inputMint: plan.swap.inputMint,
						outputMint: plan.swap.outputMint,
						outAmountMin: plan.swap.outAmountMin,
						inDecimals:
							plan.swap.inputMint === meta.tokenXMint
								? meta.decimalsX
								: meta.decimalsY,
						outDecimals:
							plan.swap.outputMint === meta.tokenXMint
								? meta.decimalsX
								: meta.decimalsY,
					};
		console.log(
			paint(
				"DRY_RUN",
				formatDryRunBox({
					pool: snapshot.poolAddress,
					active: snapshot.activeBinId,
					oldLower: snapshot.lowerBinId,
					oldUpper: snapshot.upperBinId,
					newLower: plan.lowerBinId,
					newUpper: plan.upperBinId,
					strategy: plan.strategy,
					swap,
					depositX: plan.depositX,
					depositY: plan.depositY,
					decimalsX: meta.decimalsX,
					decimalsY: meta.decimalsY,
					...(fees ? { feeX: fees.feeX, feeY: fees.feeY } : {}),
				}),
			),
		);
	});

// why: recovery must not withdraw again: the position is already empty and
// alive, funds sit in the wallet, so resume from the wallet snapshot.
export const completeRebalanceFromWallet = (
	ctx: RebalanceContext,
	config: BotConfig,
	snapshot: PositionSnapshot,
	plan: RebalancePlan,
	walletBefore: WalletSnapshot,
	claimedFees?: ClaimedFees,
): Effect.Effect<void, DlmmError> =>
	Effect.gen(function* () {
		const { connection, dlmm, owner } = ctx;
		if (snapshot.status === "Error")
			return yield* dlmmFail("snapshot error, abort rebalance");
		if (!config.positionPubkey)
			return yield* dlmmFail("POSITION_PUBKEY missing, abort rebalance");
		const positionAddress = new PublicKey(config.positionPubkey);
		const tokenXMint = dlmm.tokenX.publicKey;
		const tokenYMint = dlmm.tokenY.publicKey;
		const sdkStrategy: StrategyType = sdkStrategyOf(plan.strategy);
		const beforeSol = mustBaseUnit(
			walletBefore.sol,
			"walletBeforeSol",
		).toNumber();
		const floorLamports =
			Math.max(config.solReserveLamports, beforeSol) + TX_FEE_BUFFER_LAMPORTS;
		const involvesSol =
			tokenXMint.toBase58() === NATIVE_MINT ||
			tokenYMint.toBase58() === NATIVE_MINT;
		const maybeWrapSolLeg = (): Effect.Effect<void, DlmmError> =>
			involvesSol
				? wrapSolLeg(
						connection,
						owner,
						floorLamports,
						config.solReserveLamports,
					)
				: Effect.void;

		// Explicit pre-withdraw fees win when the normal path provides them;
		// a recovery re-read sees the emptied position (zero fees), so already
		// claimed fees mixed in the wallet stay deposited unless the caller
		// passes the known amounts.
		const livePosition = yield* Effect.tryPromise({
			try: () => dlmm.getPosition(positionAddress),
			catch: (e) =>
				new DlmmError(
					`getPosition failed: ${e instanceof Error ? e.message : String(e)}`,
				),
		});
		const active = yield* Effect.tryPromise({
			try: () => dlmm.getActiveBin(),
			catch: (e) =>
				new DlmmError(
					`getActiveBin failed: ${e instanceof Error ? e.message : String(e)}`,
				),
		});

		yield* maybeWrapSolLeg();
		const feeXStr =
			claimedFees?.feeX ?? livePosition.positionData.feeX.toString();
		const feeYStr =
			claimedFees?.feeY ?? livePosition.positionData.feeY.toString();
		const walletCurrentX = yield* readWalletLeg(
			connection,
			owner.publicKey,
			tokenXMint,
			"X",
			"read",
		);
		const walletCurrentY = yield* readWalletLeg(
			connection,
			owner.publicKey,
			tokenYMint,
			"Y",
			"read",
		);

		const rawDelta = deriveTopUp({
			beforeX: walletBefore.x,
			afterX: walletCurrentX.toString(),
			beforeY: walletBefore.y,
			afterY: walletCurrentY.toString(),
		});
		const { sizedX, sizedY } = sizeFromWalletDelta({
			deltaX: rawDelta.topUpX,
			deltaY: rawDelta.topUpY,
			feeX: feeXStr,
			feeY: feeYStr,
			compoundFees: config.compoundFees,
		});
		const balancedPlan = yield* computeBalancedPlan({
			activeBinId: snapshot.activeBinId,
			widthBins: resolveWidth(
				snapshot.lowerBinId,
				snapshot.upperBinId,
				config.positionWidthBins,
			),
			strategy: plan.strategy,
			tokenXMint: tokenXMint.toBase58(),
			tokenYMint: tokenYMint.toBase58(),
			withdrawnX: sizedX,
			withdrawnY: sizedY,
			activePrice: active.price,
			slippageBps: config.swapSlippageBps,
		});

		// Always POST /execute, never self-send: a winning jupiterz route
		// needs the market-maker co-sign from /execute.
		if (balancedPlan.swap.kind === "swap") {
			const ordered = yield* getJupiterOrder({
				inputMint: balancedPlan.swap.inputMint,
				outputMint: balancedPlan.swap.outputMint,
				amount: balancedPlan.swap.inAmount,
				slippageBps: config.swapSlippageBps,
				taker: owner.publicKey.toBase58(),
			}).pipe(Effect.mapError(swapErrToDlmm));
			const signedTransactionB64 = yield* Effect.try({
				try: () => {
					const tx = VersionedTransaction.deserialize(
						Uint8Array.from(Buffer.from(ordered.transactionB64, "base64")),
					);
					tx.sign([owner]);
					return Buffer.from(tx.serialize()).toString("base64");
				},
				catch: (e) =>
					new DlmmError(
						`jupiter swap sign failed: ${e instanceof Error ? e.message : String(e)}`,
					),
			});
			const executed = yield* executeJupiterOrder({
				signedTransactionB64,
				requestId: ordered.requestId,
			}).pipe(Effect.mapError(swapErrToDlmm));
			const actualOut = actualSwapOut(
				executed.totalOut,
				ordered.order.outAmount,
			);
			yield* Effect.sync(() =>
				log(
					"LIVE",
					`jupiter swap ${executed.signature} ${txLink(executed.signature)} ` +
						`router=${ordered.order.router} mode=${ordered.order.mode} out=${actualOut}`,
				),
			);
		}

		// Jupiter pays the SOL leg as native and closes the wSOL ATA; re-wrap
		// it before the topUp read.
		yield* maybeWrapSolLeg();
		const walletAfterX = yield* readWalletLeg(
			connection,
			owner.publicKey,
			tokenXMint,
			"X",
			"re-read",
		);
		const walletAfterY = yield* readWalletLeg(
			connection,
			owner.publicKey,
			tokenYMint,
			"Y",
			"re-read",
		);
		const { topUpX: rawTopUpX, topUpY: rawTopUpY } = deriveTopUp({
			beforeX: walletBefore.x,
			afterX: walletAfterX.toString(),
			beforeY: walletBefore.y,
			afterY: walletAfterY.toString(),
		});
		const topUpX = config.compoundFees
			? rawTopUpX
			: excludeFees(rawTopUpX, feeXStr);
		const topUpY = config.compoundFees
			? rawTopUpY
			: excludeFees(rawTopUpY, feeYStr);
		const capped = yield* Effect.try({
			try: () =>
				capTopUpToBalances({
					topUpX,
					topUpY,
					balanceX: walletAfterX.toString(),
					balanceY: walletAfterY.toString(),
				}),
			catch: (e) => (e instanceof DlmmError ? e : new DlmmError(String(e))),
		});
		const emptied = yield* Effect.tryPromise({
			try: () => dlmm.getPosition(positionAddress),
			catch: (e) =>
				new DlmmError(
					`getPosition (emptied) failed: ${e instanceof Error ? e.message : String(e)}`,
				),
		});
		const response = yield* Effect.tryPromise({
			try: () =>
				dlmm.simulateRebalancePositionWithBalancedStrategy(
					positionAddress,
					emptied.positionData,
					sdkStrategy,
					new BN(capped.topUpX),
					new BN(capped.topUpY),
					new BN(FULL_HAIRCUT_BPS),
					new BN(FULL_HAIRCUT_BPS),
				),
			catch: (e) =>
				new DlmmError(
					`simulate rebalance failed: ${e instanceof Error ? e.message : String(e)}`,
				),
		});
		const { initBinArrayInstructions, rebalancePositionInstruction } =
			yield* Effect.tryPromise({
				try: () =>
					dlmm.rebalancePosition(
						response,
						new BN(REBALANCE_ACTIVE_BIN_SLIPPAGE),
						owner.publicKey,
						slippagePct(config.slippageBps),
					),
				catch: (e) =>
					new DlmmError(
						`rebalancePosition failed: ${e instanceof Error ? e.message : String(e)}`,
					),
			});
		if (initBinArrayInstructions.length > 0) {
			const sig = yield* Effect.tryPromise({
				try: () =>
					sendInstructions(connection, owner, initBinArrayInstructions),
				catch: (e) =>
					new DlmmError(
						`initBinArray send failed: ${e instanceof Error ? e.message : String(e)}`,
					),
			});
			yield* Effect.sync(() =>
				log("LIVE", `initBinArray ${sig} ${txLink(sig)}`),
			);
		}
		const range = simulatedRange(response, balancedPlan);
		const rebalanceSig = yield* Effect.tryPromise({
			try: () =>
				sendInstructions(connection, owner, rebalancePositionInstruction),
			catch: (e) =>
				new DlmmError(
					`rebalance send failed: ${e instanceof Error ? e.message : String(e)}`,
				),
		});
		yield* Effect.sync(() =>
			log(
				"LIVE",
				`rebalance in place ${rebalanceSig} ${txLink(rebalanceSig)} ` +
					`position=${positionAddress.toBase58()} ` +
					`newRange=[${range.lowerBinId},${range.upperBinId}] strategy=${plan.strategy}`,
			),
		);
	});

export interface DryRunBundleSketch {
	readonly swap: SwapDirection;
	readonly involvesSol: boolean;
	readonly tipAccount: string | null;
	readonly tipLamports: number;
}

export const logDryRunBundlePlan = (
	sketch: DryRunBundleSketch,
): Effect.Effect<void> =>
	Effect.sync(() => {
		const legs = [
			"withdraw (sequential first, so Jupiter sees wallet funds)",
			...(sketch.involvesSol ? ["wrap?"] : []),
			...(sketch.swap.kind === "swap" ? ["swap(signed)"] : []),
			"deposit+tip-last",
		];
		console.log(
			paint(
				"DRY_RUN",
				[
					"jito bundle plan (nothing sent):",
					...legs.map((label, i) => `  [${i}] ${label}`),
					sketch.tipAccount
						? `  tip ${(sketch.tipLamports / 1e9).toFixed(9)} SOL -> ${sketch.tipAccount} (in last tx)`
						: "  tip account unavailable",
				].join("\n"),
			),
		);
	});

export interface PostWithdrawBundleArgs {
	readonly ctx: RebalanceContext;
	readonly config: BotConfig;
	readonly snapshot: PositionSnapshot;
	readonly plan: RebalancePlan;
	readonly walletBefore: WalletSnapshot;
	readonly feeXStr: string;
	readonly feeYStr: string;
}

const jitoToDlmm = (e: JitoError): DlmmError =>
	new DlmmError(`jito: ${e.message}`);

const asDlmm = (e: unknown): DlmmError =>
	e instanceof DlmmError
		? e
		: new DlmmError(`jito: ${e instanceof Error ? e.message : String(e)}`);

const signLegacyB64 = (
	tx: Transaction,
	owner: Keypair,
	blockhash: string,
): Effect.Effect<string, DlmmError> =>
	Effect.try({
		try: () => {
			tx.feePayer = owner.publicKey;
			tx.recentBlockhash = blockhash;
			tx.sign(owner);
			return Buffer.from(tx.serialize()).toString("base64");
		},
		catch: (e) =>
			new DlmmError(
				`sign legacy failed: ${e instanceof Error ? e.message : String(e)}`,
			),
	});

const withdrawAll = (args: {
	readonly ctx: RebalanceContext;
	readonly positionAddress: PublicKey;
	readonly lowerBinId: number;
	readonly upperBinId: number;
}): Effect.Effect<void, DlmmError> =>
	Effect.gen(function* () {
		const { connection, dlmm, owner } = args.ctx;
		const removeTxs = yield* Effect.tryPromise({
			try: () =>
				dlmm.removeLiquidity({
					user: owner.publicKey,
					position: args.positionAddress,
					fromBinId: args.lowerBinId,
					toBinId: args.upperBinId,
					bps: new BN(10000),
					shouldClaimAndClose: false,
				}),
			catch: (e) =>
				new DlmmError(
					`removeLiquidity failed: ${e instanceof Error ? e.message : String(e)}`,
				),
		});
		for (const tx of removeTxs) {
			const sig = yield* Effect.tryPromise({
				try: () => sendLegacy(connection, owner, tx, [owner]),
				catch: (e) =>
					new DlmmError(
						`removeLiquidity send failed: ${e instanceof Error ? e.message : String(e)}`,
					),
			});
			yield* Effect.sync(() =>
				log("LIVE", `withdraw 100% ${sig} ${txLink(sig)}`),
			);
		}
	});

// why: Jupiter validates the taker's input balance when building the swap,
// so the withdraw must land BEFORE the bundle is planned. The bundle then
// covers wrap/swap/deposit+tip atomically; a miss falls back to the
// sequential tail with the withdraw already done.
export const attemptPostWithdrawBundle = (
	args: PostWithdrawBundleArgs,
): Effect.Effect<boolean, DlmmError> =>
	Effect.gen(function* () {
		const { ctx, config, snapshot, plan, walletBefore } = args;
		const { connection, dlmm, owner } = ctx;
		if (!config.positionPubkey)
			return yield* dlmmFail("POSITION_PUBKEY missing, abort rebalance");
		const positionAddress = new PublicKey(config.positionPubkey);
		const tokenXMint = dlmm.tokenX.publicKey;
		const tokenYMint = dlmm.tokenY.publicKey;
		const sdkStrategy: StrategyType = sdkStrategyOf(plan.strategy);
		const solIsX = tokenXMint.toBase58() === NATIVE_MINT;

		const beforeSol = mustBaseUnit(
			walletBefore.sol,
			"walletBeforeSol",
		).toNumber();
		const floorLamports =
			Math.max(config.solReserveLamports, beforeSol) + TX_FEE_BUFFER_LAMPORTS;
		const needsWrap = involvesSolMint(
			tokenXMint.toBase58(),
			tokenYMint.toBase58(),
		);
		const native = yield* Effect.tryPromise({
			try: () => connection.getBalance(owner.publicKey),
			catch: (e) =>
				new DlmmError(
					`native SOL read failed: ${e instanceof Error ? e.message : String(e)}`,
				),
		});
		if (native < config.solReserveLamports) {
			return yield* dlmmFail(
				`native SOL ${(native / 1e9).toFixed(6)} below reserve ` +
					`${(config.solReserveLamports / 1e9).toFixed(6)}: top up gas, abort rebalance`,
			);
		}
		const wrapAmount = needsWrap
			? wrapAmountAboveFloor({
					nativeLamports: String(native),
					floorLamports: String(floorLamports),
				})
			: "0";

		// Live sizes from the post-withdraw wallet delta (plus the
		// not-yet-wrapped SOL leg) so Jupiter sees the input funds. Dry-run
		// sketches from pre-withdraw position totals since nothing landed.
		let sizedX: string;
		let sizedY: string;
		if (config.dryRun) {
			const prePosition = yield* Effect.tryPromise({
				try: () => dlmm.getPosition(positionAddress),
				catch: (e) =>
					new DlmmError(
						`getPosition failed: ${e instanceof Error ? e.message : String(e)}`,
					),
			});
			const preData = prePosition.positionData;
			sizedX = config.compoundFees
				? addBaseUnits(`${preData.totalXAmount}`, args.feeXStr)
				: `${preData.totalXAmount}`;
			sizedY = config.compoundFees
				? addBaseUnits(`${preData.totalYAmount}`, args.feeYStr)
				: `${preData.totalYAmount}`;
		} else {
			const walletCurrentX = yield* readWalletLeg(
				connection,
				owner.publicKey,
				tokenXMint,
				"X",
				"read",
			);
			const walletCurrentY = yield* readWalletLeg(
				connection,
				owner.publicKey,
				tokenYMint,
				"Y",
				"read",
			);
			const rawDelta = deriveTopUp({
				beforeX: walletBefore.x,
				afterX: walletCurrentX.toString(),
				beforeY: walletBefore.y,
				afterY: walletCurrentY.toString(),
			});
			const sized = sizeFromWalletDelta({
				deltaX: rawDelta.topUpX,
				deltaY: rawDelta.topUpY,
				feeX: args.feeXStr,
				feeY: args.feeYStr,
				compoundFees: config.compoundFees,
			});
			sizedX = sized.sizedX;
			sizedY = sized.sizedY;
			if (wrapAmount !== "0") {
				if (solIsX) sizedX = addBaseUnits(sizedX, wrapAmount);
				else sizedY = addBaseUnits(sizedY, wrapAmount);
			}
		}
		const active = yield* Effect.tryPromise({
			try: () => dlmm.getActiveBin(),
			catch: (e) =>
				new DlmmError(
					`getActiveBin failed: ${e instanceof Error ? e.message : String(e)}`,
				),
		});
		const balancedPlan = yield* computeBalancedPlan({
			activeBinId: snapshot.activeBinId,
			widthBins: resolveWidth(
				snapshot.lowerBinId,
				snapshot.upperBinId,
				config.positionWidthBins,
			),
			strategy: plan.strategy,
			tokenXMint: tokenXMint.toBase58(),
			tokenYMint: tokenYMint.toBase58(),
			withdrawnX: sizedX,
			withdrawnY: sizedY,
			activePrice: active.price,
			slippageBps: config.swapSlippageBps,
		});

		if (config.dryRun) {
			const legs = [
				"withdraw (sequential first)",
				...(wrapAmount !== "0" ? ["wrap?"] : []),
				...(balancedPlan.swap.kind === "swap"
					? [
							`swap(signed) in=${balancedPlan.swap.inAmount} minOut=${balancedPlan.swap.outAmountMin} (quote needs landed withdraw, skipped)`,
						]
					: []),
				"deposit+tip-last",
			];
			yield* Effect.sync(() =>
				console.log(
					paint(
						"DRY_RUN",
						`jito bundle plan (nothing sent):\n${legs.map((leg, i) => `  [${i}] ${leg}`).join("\n")}`,
					),
				),
			);
			return true;
		}

		const { blockhash } = yield* Effect.tryPromise({
			try: () => connection.getLatestBlockhash("confirmed"),
			catch: (e) =>
				new DlmmError(
					`getLatestBlockhash failed: ${e instanceof Error ? e.message : String(e)}`,
				),
		});
		const preLegs: BundleLeg[] = [];
		if (wrapAmount !== "0") {
			const wsolAta = getAssociatedTokenAddressSync(
				new PublicKey(NATIVE_MINT),
				owner.publicKey,
			);
			const ata = yield* Effect.tryPromise({
				try: () => connection.getAccountInfo(wsolAta),
				catch: (e) =>
					new DlmmError(
						`wSOL ATA read failed: ${e instanceof Error ? e.message : String(e)}`,
					),
			});
			const ixs: TransactionInstruction[] = [];
			if (!ata) {
				ixs.push(
					createAssociatedTokenAccountInstruction(
						owner.publicKey,
						wsolAta,
						owner.publicKey,
						new PublicKey(NATIVE_MINT),
					),
				);
			}
			ixs.push(
				SystemProgram.transfer({
					fromPubkey: owner.publicKey,
					toPubkey: wsolAta,
					lamports: BigInt(wrapAmount),
				}),
				createSyncNativeInstruction(wsolAta),
			);
			preLegs.push({
				label: "wrap",
				txB64: yield* signLegacyB64(
					new Transaction().add(...ixs),
					owner,
					blockhash,
				),
			});
		}

		let depositX = balancedPlan.depositX;
		let depositY = balancedPlan.depositY;
		const swapLegs: BundleLeg[] = [];
		if (balancedPlan.swap.kind === "swap") {
			const ordered = yield* getJupiterOrder({
				inputMint: balancedPlan.swap.inputMint,
				outputMint: balancedPlan.swap.outputMint,
				amount: balancedPlan.swap.inAmount,
				slippageBps: config.swapSlippageBps,
				taker: owner.publicKey.toBase58(),
			}).pipe(Effect.mapError(swapErrToDlmm));
			if (
				mustBaseUnit(ordered.order.outAmount, "jupiterOut").lt(
					mustBaseUnit(balancedPlan.swap.outAmountMin, "outMin"),
				)
			) {
				return yield* dlmmFail(
					`jupiter out ${ordered.order.outAmount} below min ` +
						`${balancedPlan.swap.outAmountMin}, fallback to sequential`,
				);
			}
			const signedB64 = yield* signJupiterOrder({
				transactionB64: ordered.transactionB64,
				owner,
			}).pipe(Effect.mapError(swapErrToDlmm));
			swapLegs.push({ label: "swap", txB64: signedB64 });
			if (balancedPlan.swap.outputMint === tokenXMint.toBase58()) {
				depositX = addBaseUnits(sizedX, ordered.order.outAmount);
			} else {
				depositY = addBaseUnits(sizedY, ordered.order.outAmount);
			}
			yield* Effect.sync(() =>
				log(
					"LIVE",
					`jito swap router=${ordered.order.router} mode=${ordered.order.mode} ` +
						`out=${ordered.order.outAmount}`,
				),
			);
		}

		const emptied = yield* Effect.tryPromise({
			try: () => dlmm.getPosition(positionAddress),
			catch: (e) =>
				new DlmmError(
					`getPosition (emptied) failed: ${e instanceof Error ? e.message : String(e)}`,
				),
		});
		const response = yield* Effect.tryPromise({
			try: () =>
				dlmm.simulateRebalancePositionWithBalancedStrategy(
					positionAddress,
					emptied.positionData,
					sdkStrategy,
					new BN(depositX),
					new BN(depositY),
					new BN(FULL_HAIRCUT_BPS),
					new BN(FULL_HAIRCUT_BPS),
				),
			catch: (e) =>
				new DlmmError(
					`simulate rebalance failed: ${e instanceof Error ? e.message : String(e)}`,
				),
		});
		const { initBinArrayInstructions, rebalancePositionInstruction } =
			yield* Effect.tryPromise({
				try: () =>
					dlmm.rebalancePosition(
						response,
						new BN(REBALANCE_ACTIVE_BIN_SLIPPAGE),
						owner.publicKey,
						slippagePct(config.slippageBps),
					),
				catch: (e) =>
					new DlmmError(
						`rebalancePosition failed: ${e instanceof Error ? e.message : String(e)}`,
					),
			});
		const midLegs: BundleLeg[] = [];
		if (initBinArrayInstructions.length > 0) {
			midLegs.push({
				label: "initBinArray",
				txB64: yield* signLegacyB64(
					new Transaction().add(...initBinArrayInstructions),
					owner,
					blockhash,
				),
			});
		}
		const tipAccounts = yield* getTipAccounts({
			blockEngineUrl: config.jitoBlockEngineUrl,
		}).pipe(Effect.mapError(jitoToDlmm));
		const tipAccount = yield* Effect.try({
			try: () => pickTipAccount(tipAccounts),
			catch: asDlmm,
		});
		const lastTx = new Transaction().add(
			...rebalancePositionInstruction,
			SystemProgram.transfer({
				fromPubkey: owner.publicKey,
				toPubkey: new PublicKey(tipAccount),
				lamports: config.jitoTipLamports,
			}),
		);
		const bundleLegs: readonly BundleLeg[] = [
			...preLegs,
			...swapLegs,
			...midLegs,
			{
				label: "deposit+tip",
				txB64: yield* signLegacyB64(lastTx, owner, blockhash),
			},
		];
		const bundlePlan = {
			legs: bundleLegs,
			tipAccount,
			tipLamports: config.jitoTipLamports,
		};
		yield* Effect.try({
			try: () => assertBundlePlan(bundlePlan),
			catch: asDlmm,
		});

		const txB64s = bundlePlan.legs.map((l) => l.txB64);
		yield* simulateJitoBundle({
			blockEngineUrl: config.jitoBlockEngineUrl,
			transactions: txB64s,
		}).pipe(Effect.mapError(jitoToDlmm));
		yield* Effect.sync(() =>
			log("LIVE", `jito bundle simulated ok (${txB64s.length} txs)`),
		);
		const bundleId = yield* sendJitoBundle({
			blockEngineUrl: config.jitoBlockEngineUrl,
			transactions: txB64s,
		}).pipe(Effect.mapError(jitoToDlmm));
		yield* Effect.sync(() => log("LIVE", `jito bundle sent ${bundleId}`));
		const final: BundleStatus = yield* pollBundleStatus({
			blockEngineUrl: config.jitoBlockEngineUrl,
			bundleId,
		}).pipe(
			Effect.catch((e: JitoError) =>
				dlmmFail(`jito poll failed (${e.message}), fallback to sequential`),
			),
		);
		if (final._tag === "Landed") {
			yield* Effect.sync(() =>
				log("LIVE", `jito bundle landed ${bundleId} slot=${final.slot ?? "?"}`),
			);
			return true;
		}
		if (final._tag === "Failed") {
			return yield* dlmmFail(
				`jito bundle ${bundleId} failed (${final.reason}), fallback to sequential`,
			);
		}
		return yield* dlmmFail(
			`jito bundle ${bundleId} timed out, fallback to sequential`,
		);
	});

export const executeRebalance = (
	ctx: RebalanceContext,
	config: BotConfig,
	snapshot: PositionSnapshot,
	plan: RebalancePlan,
): Effect.Effect<void, DlmmError> =>
	Effect.gen(function* () {
		const { connection, dlmm, owner } = ctx;
		if (snapshot.status === "Error")
			return yield* dlmmFail("snapshot error, abort rebalance");
		if (!config.positionPubkey)
			return yield* dlmmFail("POSITION_PUBKEY missing, abort rebalance");
		const positionAddress = new PublicKey(config.positionPubkey);
		const tokenXMint = dlmm.tokenX.publicKey;
		const tokenYMint = dlmm.tokenY.publicKey;

		// Sizing lives in completeRebalanceFromWallet so a recovery can reuse
		// it without withdrawing again.
		const lbPosition = yield* Effect.tryPromise({
			try: () => dlmm.getPosition(positionAddress),
			catch: (e) =>
				new DlmmError(
					`getPosition failed: ${e instanceof Error ? e.message : String(e)}`,
				),
		});
		const positionData = lbPosition.positionData;
		const feeXStr = positionData.feeX.toString();
		const feeYStr = positionData.feeY.toString();
		const walletBeforeX = yield* Effect.tryPromise({
			try: () => walletBalanceOf(connection, owner.publicKey, tokenXMint),
			catch: (e) =>
				new DlmmError(
					`wallet X snapshot failed: ${e instanceof Error ? e.message : String(e)}`,
				),
		});
		const walletBeforeY = yield* Effect.tryPromise({
			try: () => walletBalanceOf(connection, owner.publicKey, tokenYMint),
			catch: (e) =>
				new DlmmError(
					`wallet Y snapshot failed: ${e instanceof Error ? e.message : String(e)}`,
				),
		});
		const walletBeforeSol = yield* Effect.tryPromise({
			try: () => connection.getBalance(owner.publicKey),
			catch: (e) =>
				new DlmmError(
					`wallet SOL snapshot failed: ${e instanceof Error ? e.message : String(e)}`,
				),
		});

		// Phase-split Jito path: the withdraw lands first so Jupiter sees
		// wallet funds, then wrap/swap/deposit+tip go as one bundle. Any
		// bundle failure falls back to the sequential tail (withdraw done).
		if (config.jitoEnabled) {
			if (!config.dryRun) {
				yield* withdrawAll({
					ctx,
					positionAddress,
					lowerBinId: positionData.lowerBinId,
					upperBinId: positionData.upperBinId,
				});
			}
			const landed = yield* attemptPostWithdrawBundle({
				ctx,
				config,
				snapshot,
				plan,
				walletBefore: {
					x: walletBeforeX.toString(),
					y: walletBeforeY.toString(),
					sol: String(walletBeforeSol),
				},
				feeXStr,
				feeYStr,
			}).pipe(
				Effect.catch((e: DlmmError) =>
					Effect.sync(() => {
						log(
							"WARN",
							`jito bundle skipped (${e.message}), sequential fallback`,
						);
						return false;
					}),
				),
			);
			if (landed) return;
			if (config.dryRun) return;
			yield* completeRebalanceFromWallet(
				ctx,
				config,
				snapshot,
				plan,
				{
					x: walletBeforeX.toString(),
					y: walletBeforeY.toString(),
					sol: String(walletBeforeSol),
				},
				{ feeX: feeXStr, feeY: feeYStr },
			);
			return;
		}

		// 2. Withdraw 100% but keep the position account alive.
		yield* withdrawAll({
			ctx,
			positionAddress,
			lowerBinId: positionData.lowerBinId,
			upperBinId: positionData.upperBinId,
		});

		// One flow shared with recovery scripts.
		yield* completeRebalanceFromWallet(
			ctx,
			config,
			snapshot,
			plan,
			{
				x: walletBeforeX.toString(),
				y: walletBeforeY.toString(),
				sol: String(walletBeforeSol),
			},
			{ feeX: feeXStr, feeY: feeYStr },
		);
	});
