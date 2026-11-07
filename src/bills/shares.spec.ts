import { splitPence } from "./shares";

describe("splitPence", () => {
	it("always adds up to the bill", () => {
		const shares = splitPence(10000, ["a", "b", "c"]);
		expect(shares.map(s => s.amount)).toEqual([3334, 3333, 3333]);
		expect(shares.reduce((sum, s) => sum + s.amount, 0)).toBe(10000);
	});

	it("returns nothing for nobody", () => {
		expect(splitPence(500, [])).toEqual([]);
	});
});
