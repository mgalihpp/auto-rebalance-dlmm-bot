import type { StrategyType } from "@meteora-ag/dlmm";
import {
	type Connection,
	type Keypair,
	PublicKey,
	Transaction,
	type TransactionInstruction,
	type VersionedTransaction,
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
import { formatDryRunBox, log, paint, txLink } from "./log.ts";
import {
	buildJupiterSwapTransactions,
	getJupiterQuote,
	type SwapError,
} from "./swap.ts";

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
// withdraws MAX_BPS on the old range (a no-op once emptied) and deposits
// purely from topUp, so a full haircut means zero redeposit from the position.
const FULL_HAIRCUT_BPS = 10000;
const MAX_BPS = 10000;
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

// why: callers size the swap on totalX+feeX / totalY+feeY, so keep the raw
// addition pure and offline-testable instead of burying it in the flow.
export const addBaseUnits = (a: string, b: string): string =>
	mustBaseUnit(a, "amount").add(mustBaseUnit(b, "amount")).toString();

// why: COMPOUND_FEES=false leaves web-style fees claimed in the wallet, so the
// topUp derived from the wallet delta must exclude them, floored at zero for
// lamport dust. Pure and offline-testable; callers wrap deriveTopUp with it.
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
// Mirrors SDK: total*(MAX-haircut)/MAX, so a full haircut redeposits nothing.
export const redepositAfterHaircut = (
	totalBaseUnit: string,
	haircutBps: number,
): string => {
	const total = mustBaseUnit(totalBaseUnit, "total");
	const haircut = Math.min(Math.max(Math.floor(haircutBps), 0), MAX_BPS);
	return total
		.mul(new BN(MAX_BPS - haircut))
		.div(new BN(MAX_BPS))
		.toString();
};

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
	return 3;
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

const sendVersioned = async (
	connection: Connection,
	tx: VersionedTransaction,
	owner: Keypair,
): Promise<string> => {
	tx.sign([owner]);
	const sig = await connection.sendTransaction(tx, { skipPreflight: false });
	const res = await connection.confirmTransaction(sig, "confirmed");
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

// why: removeLiquidity unwraps wSOL to native SOL, so a SOL leg must count
// native lamports plus any wSOL dust. SPL legs just sum parsed token accounts.
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
	if (mint.toBase58() === NATIVE_MINT) {
		total = total.add(new BN(await connection.getBalance(owner)));
	}
	return total;
};

const toNum = (v: number | BN): number =>
	typeof v === "number" ? v : v.toNumber();

// why: the SDK centers the deposit on the live active bin with the old width,
// so the box and logs show that true range instead of the manual guess.
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
			Effect.catch(() => Effect.succeed(null as SimulateResponse | null)),
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

		// 1. Read position + active bin, snapshot wallet before withdraw.
		const lbPosition = yield* Effect.tryPromise({
			try: () => dlmm.getPosition(positionAddress),
			catch: (e) =>
				new DlmmError(
					`getPosition failed: ${e instanceof Error ? e.message : String(e)}`,
				),
		});
		const positionData = lbPosition.positionData;
		const active = yield* Effect.tryPromise({
			try: () => dlmm.getActiveBin(),
			catch: (e) =>
				new DlmmError(
					`getActiveBin failed: ${e instanceof Error ? e.message : String(e)}`,
				),
		});
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

		// 2. Size the swap on total+fee, not withdrawn-only.
		const sdkStrategy: StrategyType = sdkStrategyOf(plan.strategy);
		const feeXStr = positionData.feeX.toString();
		const feeYStr = positionData.feeY.toString();
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
			withdrawnX: config.compoundFees
				? addBaseUnits(positionData.totalXAmount, feeXStr)
				: positionData.totalXAmount,
			withdrawnY: config.compoundFees
				? addBaseUnits(positionData.totalYAmount, feeYStr)
				: positionData.totalYAmount,
			activePrice: active.price,
			slippageBps: config.swapSlippageBps,
		});

		// 3. Withdraw 100% but keep the position account alive.
		const removeTxs = yield* Effect.tryPromise({
			try: () =>
				dlmm.removeLiquidity({
					user: owner.publicKey,
					position: positionAddress,
					fromBinId: positionData.lowerBinId,
					toBinId: positionData.upperBinId,
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

		// 4. Jupiter swap as-is, then derive the actual topUp from wallet delta.
		if (balancedPlan.swap.kind === "swap") {
			const quoted = yield* getJupiterQuote({
				baseUrl: config.jupiterQuoteBaseUrl,
				inputMint: balancedPlan.swap.inputMint,
				outputMint: balancedPlan.swap.outputMint,
				amount: balancedPlan.swap.inAmount,
				slippageBps: config.swapSlippageBps,
			}).pipe(Effect.mapError(swapErrToDlmm));
			const swapTxs = yield* buildJupiterSwapTransactions({
				baseUrl: config.jupiterQuoteBaseUrl,
				userPublicKey: owner.publicKey,
				quoteResponse: quoted.rawResponse,
			}).pipe(Effect.mapError(swapErrToDlmm));
			for (const tx of swapTxs) {
				const sig = yield* Effect.tryPromise({
					try: () => sendVersioned(connection, tx, owner),
					catch: (e) =>
						new DlmmError(
							`jupiter swap send failed: ${e instanceof Error ? e.message : String(e)}`,
						),
				});
				yield* Effect.sync(() =>
					log("LIVE", `jupiter swap ${sig} ${txLink(sig)}`),
				);
			}
		}
		const walletAfterX = yield* Effect.tryPromise({
			try: () => walletBalanceOf(connection, owner.publicKey, tokenXMint),
			catch: (e) =>
				new DlmmError(
					`wallet X re-read failed: ${e instanceof Error ? e.message : String(e)}`,
				),
		});
		const walletAfterY = yield* Effect.tryPromise({
			try: () => walletBalanceOf(connection, owner.publicKey, tokenYMint),
			catch: (e) =>
				new DlmmError(
					`wallet Y re-read failed: ${e instanceof Error ? e.message : String(e)}`,
				),
		});
		const { topUpX: rawTopUpX, topUpY: rawTopUpY } = deriveTopUp({
			beforeX: walletBeforeX.toString(),
			afterX: walletAfterX.toString(),
			beforeY: walletBeforeY.toString(),
			afterY: walletAfterY.toString(),
		});
		const topUpX = config.compoundFees
			? rawTopUpX
			: excludeFees(rawTopUpX, feeXStr);
		const topUpY = config.compoundFees
			? rawTopUpY
			: excludeFees(rawTopUpY, feeYStr);

		// 5. Rebalance the same position in place: full haircut, deposit is topUp.
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
					new BN(topUpX),
					new BN(topUpY),
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
