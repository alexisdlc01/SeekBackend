import { matchHome } from "./listing-match";

describe("matchHome", () => {
	const home = { rentPerPerson: 600, bedrooms: 4, billsIncluded: true, availableFrom: "2026-09-01T00:00:00Z", distanceKm: 0.8 };

	it("scores a home that fits every preference and explains why", () => {
		const result = matchHome(home, { maxRent: 650, minBedrooms: 4, billsIncluded: true, moveInBy: "2026-09-30" });
		// 70 + 8 distance + 6 move-in + 8 bills + 8 budget + 6 bedrooms = 106, clamped.
		expect(result.match).toBe(99);
		expect(result.reasons).toEqual(["10 min walk to campus", "free 1 Sep", "bills included", "under £650", "4 bedrooms"]);
	});

	it("marks down a home over budget without bills and never goes under 40", () => {
		expect(matchHome({ ...home, rentPerPerson: 900, billsIncluded: false, distanceKm: 8 }, { maxRent: 600, billsIncluded: true }).match).toBe(40);
		expect(matchHome({ ...home, rentPerPerson: 660, billsIncluded: false, distanceKm: null, availableFrom: null }, { maxRent: 600 }).match).toBe(64);
	});
});
