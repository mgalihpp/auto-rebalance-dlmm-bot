import { describe, expect, test } from "bun:test";
import { StrategyType } from "@meteora-ag/dlmm";
import {
	originalHalfRange,
	rebalanceHalfRange,
	shouldRebalance,
} from "../src/rebalance/plan.ts";
import { toStrategyType } from "../src/rebalance/types.ts";

describe("shouldRebalance", () => {
	test("stays put when centered", () => {
		expect(shouldRebalance(1000, 966, 1034)).toBe(false);
	});

	test("stays put near the edge", () => {
		expect(shouldRebalance(970, 966, 1034)).toBe(false);
		expect(shouldRebalance(1030, 966, 1034)).toBe(false);
	});

	test("fires outside the range", () => {
		expect(shouldRebalance(900, 966, 1034)).toBe(true);
		expect(shouldRebalance(1100, 966, 1034)).toBe(true);
	});
});

describe("originalHalfRange", () => {
	test("floors the half range on odd widths", () => {
		expect(originalHalfRange(0, 9)).toBe(4);
		expect(originalHalfRange(966, 1034)).toBe(34);
	});
});

describe("rebalanceHalfRange", () => {
	test("uses original range by default mode", () => {
		expect(rebalanceHalfRange({ kind: "same" }, 10, 30)).toBe(10);
	});

	test("uses configured width on each side", () => {
		expect(rebalanceHalfRange({ kind: "fixed", halfWidth: 25 }, 10, 30)).toBe(
			25,
		);
	});
});

describe("toStrategyType", () => {
	test("maps every StrategyKind to the SDK enum", () => {
		expect(toStrategyType("Spot")).toBe(StrategyType.Spot);
		expect(toStrategyType("Curve")).toBe(StrategyType.Curve);
		expect(toStrategyType("BidAsk")).toBe(StrategyType.BidAsk);
	});
});
