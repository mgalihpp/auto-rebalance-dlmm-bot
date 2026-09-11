import { describe, expect, it } from "bun:test";
import {
	parseJupiterExecuteResponse,
	parseJupiterOrderResponse,
	SwapError,
} from "../src/swap.ts";

const X_MINT = "So11111111111111111111111111111111111111112";
const Y_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const expectSwapError = (fn: () => unknown, contains: string): void => {
	try {
		fn();
	} catch (e) {
		expect(e).toBeInstanceOf(SwapError);
		expect((e as SwapError).message).toContain(contains);
		return;
	}
	throw new Error("expected SwapError, got success");
};

const orderOk = (over: Record<string, unknown> = {}) => ({
	transaction: Buffer.from("unsigned-tx-bytes").toString("base64"),
	requestId: "req-123",
	outAmount: "990",
	router: "jupiter",
	mode: "ExactIn",
	inAmount: "1000",
	...over,
});

describe("parseJupiterOrderResponse", () => {
	it("decodes a valid order with assembled transaction", () => {
		const parsed = parseJupiterOrderResponse(orderOk(), "1000");
		expect(parsed.order).toEqual({
			inAmount: "1000",
			outAmount: "990",
			router: "jupiter",
			mode: "ExactIn",
		});
		expect(parsed.requestId).toBe("req-123");
		expect(parsed.transactionB64).toBe(orderOk().transaction);
	});

	it("falls back to the request amount when inAmount is absent", () => {
		const { inAmount: _dropped, ...rest } = orderOk();
		const parsed = parseJupiterOrderResponse(rest, "1000");
		expect(parsed.order.inAmount).toBe("1000");
	});

	it("fails typed with router and errorCode when transaction is empty", () => {
		expectSwapError(
			() =>
				parseJupiterOrderResponse(
					orderOk({
						transaction: "",
						router: "jupiterz",
						errorCode: "NO_ROUTE",
						errorMessage: "no route found",
					}),
					"1000",
				),
			"jupiterz",
		);
		expectSwapError(
			() =>
				parseJupiterOrderResponse(
					orderOk({
						transaction: "",
						router: "jupiterz",
						errorCode: "NO_ROUTE",
						errorMessage: "no route found",
					}),
					"1000",
				),
			"NO_ROUTE",
		);
	});

	it("fails typed when transaction is null (quote without taker)", () => {
		expectSwapError(
			() => parseJupiterOrderResponse(orderOk({ transaction: null }), "1000"),
			"cannot build transaction",
		);
	});

	it("rejects a missing outAmount", () => {
		const { outAmount: _dropped, ...rest } = orderOk();
		expectSwapError(() => parseJupiterOrderResponse(rest, "1000"), "Jupiter order");
	});

	it("rejects a non base-unit outAmount", () => {
		expectSwapError(
			() => parseJupiterOrderResponse(orderOk({ outAmount: "1.5" }), "1000"),
			"Jupiter order",
		);
	});

	it("rejects broken base64 transaction", () => {
		expectSwapError(
			() =>
				parseJupiterOrderResponse(
					orderOk({ transaction: "!!!not-base64!!!" }),
					"1000",
				),
			"not valid base64",
		);
	});

	it("rejects a missing requestId", () => {
		const { requestId: _dropped, ...rest } = orderOk();
		expectSwapError(() => parseJupiterOrderResponse(rest, "1000"), "Jupiter order");
	});
});

describe("parseJupiterExecuteResponse", () => {
	it("decodes a Success execute with actual totals", () => {
		const parsed = parseJupiterExecuteResponse({
			status: "Success",
			signature: "sig123",
			code: 0,
			totalInputAmount: "1000",
			totalOutputAmount: "985",
			inputAmountResult: "1000",
			outputAmountResult: "985",
		});
		expect(parsed).toEqual({
			signature: "sig123",
			totalIn: "1000",
			totalOut: "985",
		});
	});

	it("defaults missing totals to zero so callers can fall back to order outAmount", () => {
		const parsed = parseJupiterExecuteResponse({
			status: "Success",
			signature: "sig123",
			code: 0,
		});
		expect(parsed).toEqual({ signature: "sig123", totalIn: "0", totalOut: "0" });
	});

	it("fails typed on Failed status", () => {
		expectSwapError(
			() =>
				parseJupiterExecuteResponse({
					status: "Failed",
					signature: "",
					code: 1,
				}),
			"status=Failed",
		);
	});

	it("fails typed on non-zero code", () => {
		expectSwapError(
			() =>
				parseJupiterExecuteResponse({
					status: "Success",
					signature: "sig123",
					code: 5,
				}),
			"code=5",
		);
	});

	it("rejects a missing signature on success", () => {
		expectSwapError(
			() =>
				parseJupiterExecuteResponse({
					status: "Success",
					code: 0,
					totalInputAmount: "1000",
					totalOutputAmount: "985",
				}),
			"missing signature",
		);
	});

	it("keeps mint fixtures valid (boundary shape)", () => {
		expect(X_MINT).toBe("So11111111111111111111111111111111111111112");
		expect(Y_MINT).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
	});
});
