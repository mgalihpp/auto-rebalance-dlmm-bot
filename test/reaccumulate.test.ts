import { describe, expect, test } from "bun:test";
import BN from "bn.js";
import { planSweepLegs, WSOL_MINT } from "../src/rebalance/reaccumulate.ts";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

describe("planSweepLegs", () => {
	test("plans a swap leg per nonzero side", () => {
		const legs = planSweepLegs({
			feeX: new BN(100),
			feeY: new BN(200),
			balX: new BN(1000),
			balY: new BN(1000),
			mintX: USDC_MINT,
			mintY: USDT_MINT,
		});
		expect(legs?.length).toBe(2);
		expect(legs?.[0]).toMatchObject({
			mint: USDC_MINT,
			kind: "swap",
		});
		expect(legs?.[0]?.amount.toString()).toBe("100");
		expect(legs?.[1]).toMatchObject({
			mint: USDT_MINT,
			kind: "swap",
		});
		expect(legs?.[1]?.amount.toString()).toBe("200");
	});

	test("marks a wSOL side as unwrap", () => {
		const legs = planSweepLegs({
			feeX: new BN(100),
			feeY: new BN(200),
			balX: new BN(1000),
			balY: new BN(1000),
			mintX: USDC_MINT,
			mintY: WSOL_MINT,
		});
		expect(legs?.length).toBe(2);
		expect(legs?.[0]?.kind).toBe("swap");
		expect(legs?.[1]).toMatchObject({ mint: WSOL_MINT, kind: "unwrap" });
		expect(legs?.[1]?.amount.toString()).toBe("200");
	});

	test("returns null when both fees are zero", () => {
		expect(
			planSweepLegs({
				feeX: new BN(0),
				feeY: new BN(0),
				balX: new BN(100),
				balY: new BN(100),
				mintX: USDC_MINT,
				mintY: USDT_MINT,
			}),
		).toBeNull();
	});

	test("caps each leg at min(fee, balance)", () => {
		const legs = planSweepLegs({
			feeX: new BN(100),
			feeY: new BN(200),
			balX: new BN(60),
			balY: new BN(300),
			mintX: USDC_MINT,
			mintY: USDT_MINT,
		});
		expect(legs?.[0]?.amount.toString()).toBe("60");
		expect(legs?.[1]?.amount.toString()).toBe("200");
	});

	test("drops a zero-capped side but keeps the other", () => {
		const legs = planSweepLegs({
			feeX: new BN(100),
			feeY: new BN(200),
			balX: new BN(0),
			balY: new BN(50),
			mintX: USDC_MINT,
			mintY: USDT_MINT,
		});
		expect(legs?.length).toBe(1);
		expect(legs?.[0]?.amount.toString()).toBe("50");
	});

	test("treats negatives as zero", () => {
		const legs = planSweepLegs({
			feeX: new BN(-5),
			feeY: new BN(20),
			balX: new BN(100),
			balY: new BN(100),
			mintX: USDC_MINT,
			mintY: USDT_MINT,
		});
		expect(legs?.length).toBe(1);
		expect(legs?.[0]?.amount.toString()).toBe("20");
		expect(
			planSweepLegs({
				feeX: new BN(-5),
				feeY: new BN(-7),
				balX: new BN(100),
				balY: new BN(100),
				mintX: USDC_MINT,
				mintY: USDT_MINT,
			}),
		).toBeNull();
		expect(
			planSweepLegs({
				feeX: new BN(100),
				feeY: new BN(200),
				balX: new BN(-1),
				balY: new BN(-2),
				mintX: USDC_MINT,
				mintY: USDT_MINT,
			}),
		).toBeNull();
	});

	test("merges both-wSOL sides into one unwrap leg", () => {
		const legs = planSweepLegs({
			feeX: new BN(100),
			feeY: new BN(200),
			balX: new BN(1000),
			balY: new BN(1000),
			mintX: WSOL_MINT,
			mintY: WSOL_MINT,
		});
		expect(legs?.length).toBe(1);
		expect(legs?.[0]).toMatchObject({ mint: WSOL_MINT, kind: "unwrap" });
		expect(legs?.[0]?.amount.toString()).toBe("300");
	});
});
