import type BN from "bn.js";
import Decimal from "decimal.js";

export function formatBn(value: BN): string {
	return new Decimal(value.toString()).toFixed(0);
}

// Local HH:MM:SS stamp so stage logs form a realtime timeline.
export function nowStamp(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
