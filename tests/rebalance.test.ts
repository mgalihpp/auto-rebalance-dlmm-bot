import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { DlmmError } from "../src/dlmm.ts";
import {
	addBaseUnits,
	type BalancedPlanInputs,
	centerRange,
	computeBalancedPlan,
	deriveTopUp,
	excludeFees,
	redepositAfterHaircut,
	resolveWidth,
} from "../src/rebalance.ts";

const X_MINT = "So11111111111111111111111111111111111111112";
const Y_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const inputs = (over: Partial<BalancedPlanInputs>): BalancedPlanInputs => ({
	activeBinId: 100,
	widthBins: 5,
	strategy: "Spot",
	tokenXMint: X_MINT,
	tokenYMint: Y_MINT,
	withdrawnX: "0",
	withdrawnY: "0",
	activePrice: "1",
	slippageBps: 100,
	...over,
});

const run = <A>(eff: Effect.Effect<A, DlmmError>): Promise<A> =>
	Effect.runPromise(eff);

const runError = (eff: Effect.Effect<unknown, DlmmError>): Promise<DlmmError> =>
	Effect.runPromise(Effect.flip(eff));

describe("resolveWidth", () => {
	it("prefers an explicit override", () => {
		expect(resolveWidth(90, 110, 7)).toBe(7);
	});

	it("follows the snapshot range width", () => {
		expect(resolveWidth(90, 110, null)).toBe(21);
	});

	it("falls back to a minimal window without a snapshot range", () => {
		expect(resolveWidth(null, null, null)).toBe(3);
	});
});

describe("centerRange", () => {
	it("centers an odd width on the active bin", () => {
		expect(centerRange(100, 5)).toEqual({ lowerBinId: 98, upperBinId: 102 });
	});

	it("clamps degenerate widths to one bin", () => {
		expect(centerRange(100, 0)).toEqual({ lowerBinId: 100, upperBinId: 100 });
	});
});

describe("computeBalancedPlan", () => {
	it("X-only needs a swap from X to Y", async () => {
		const plan = await run(
			computeBalancedPlan(inputs({ withdrawnX: "1000", withdrawnY: "0" })),
		);
		expect(plan.swap.kind).toBe("swap");
		if (plan.swap.kind === "swap") {
			expect(plan.swap.inputMint).toBe(X_MINT);
			expect(plan.swap.outputMint).toBe(Y_MINT);
			expect(plan.swap.inAmount).toBe("500");
		}
	});

	it("Y-only needs a swap from Y to X", async () => {
		const plan = await run(
			computeBalancedPlan(inputs({ withdrawnX: "0", withdrawnY: "1000" })),
		);
		expect(plan.swap.kind).toBe("swap");
		if (plan.swap.kind === "swap") {
			expect(plan.swap.inputMint).toBe(Y_MINT);
			expect(plan.swap.outputMint).toBe(X_MINT);
			expect(plan.swap.inAmount).toBe("500");
		}
	});

	it("balanced deposits need no swap", async () => {
		const plan = await run(
			computeBalancedPlan(inputs({ withdrawnX: "100", withdrawnY: "100" })),
		);
		expect(plan.swap).toEqual({ kind: "none" });
		expect(plan.depositX).toBe("100");
		expect(plan.depositY).toBe("100");
	});

	it("empty withdrawals fail with a typed error", async () => {
		const err = await runError(
			computeBalancedPlan(inputs({ withdrawnX: "0", withdrawnY: "0" })),
		);
		expect(err).toBeInstanceOf(DlmmError);
		expect(err.message).toContain("nothing withdrawn");
	});

	it("a non-numeric price fails with a typed error", async () => {
		const err = await runError(
			computeBalancedPlan(
				inputs({ withdrawnX: "100", withdrawnY: "100", activePrice: "abc" }),
			),
		);
		expect(err).toBeInstanceOf(DlmmError);
		expect(err.message).toContain("not numeric");
	});

	it("sizes the swap on total+fee when compounding, principal-only otherwise", async () => {
		// COMPOUND_FEES=true: caller passes total+fee "1200"/"0".
		const compounded = addBaseUnits("1000", "200");
		expect(compounded).toBe("1200");
		const planCompound = await run(
			computeBalancedPlan(inputs({ withdrawnX: compounded, withdrawnY: "0" })),
		);
		expect(planCompound.swap.kind).toBe("swap");
		if (planCompound.swap.kind === "swap") {
			expect(planCompound.swap.inAmount).toBe("600");
		}
		// COMPOUND_FEES=false: caller passes principal only "1000"/"0".
		const planPrincipal = await run(
			computeBalancedPlan(inputs({ withdrawnX: "1000", withdrawnY: "0" })),
		);
		expect(planPrincipal.swap.kind).toBe("swap");
		if (planPrincipal.swap.kind === "swap") {
			expect(planPrincipal.swap.inAmount).toBe("500");
		}
	});
});

describe("addBaseUnits", () => {
	it("adds total and fee amounts", () => {
		expect(addBaseUnits("1000", "200")).toBe("1200");
		expect(addBaseUnits("0", "0")).toBe("0");
	});
});

describe("redepositAfterHaircut", () => {
	it("a full 10000 bps haircut redeposits nothing", () => {
		expect(redepositAfterHaircut("1200", 10000)).toBe("0");
	});

	it("a zero haircut redeposits the full total", () => {
		expect(redepositAfterHaircut("1200", 0)).toBe("1200");
	});
});

describe("excludeFees", () => {
	it("subtracts the fee from the wallet delta", () => {
		expect(excludeFees("1200", "200")).toBe("1000");
		expect(excludeFees("500", "0")).toBe("500");
	});

	it("floors at zero when the fee exceeds the delta", () => {
		expect(excludeFees("100", "200")).toBe("0");
		expect(excludeFees("0", "50")).toBe("0");
	});

	it("rejects non-base-unit input with a typed error", () => {
		expect(() => excludeFees("1.5", "10")).toThrow(DlmmError);
		expect(() => excludeFees("100", "-5")).toThrow(DlmmError);
		expect(() => excludeFees("abc", "10")).toThrow(DlmmError);
	});

	it("leaves the fee in the wallet when COMPOUND_FEES=false", () => {
		// Wallet delta after withdraw+swap is 1200/700, fees are 200/100.
		// Principal-only topUp keeps 200/100 untouched in the wallet.
		const delta = deriveTopUp({
			beforeX: "50",
			afterX: "1250",
			beforeY: "30",
			afterY: "730",
		});
		const topUpX = excludeFees(delta.topUpX, "200");
		const topUpY = excludeFees(delta.topUpY, "100");
		expect(topUpX).toBe("1000");
		expect(topUpY).toBe("600");
	});
});

describe("deriveTopUp", () => {
	it("derives the topUp from post-swap minus pre-withdraw snapshot", () => {
		expect(
			deriveTopUp({
				beforeX: "50",
				afterX: "1250",
				beforeY: "30",
				afterY: "730",
			}),
		).toEqual({ topUpX: "1200", topUpY: "700" });
	});

	it("floors at zero when fees eat into the snapshot", () => {
		expect(
			deriveTopUp({
				beforeX: "100",
				afterX: "90",
				beforeY: "0",
				afterY: "0",
			}),
		).toEqual({ topUpX: "0", topUpY: "0" });
	});
});
