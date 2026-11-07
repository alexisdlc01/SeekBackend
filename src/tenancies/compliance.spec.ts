import { Types } from "mongoose";
import { depositCapPence, depositProtectionDeadline, listingCompliance, sortCompliance, tenancyCompliance } from "./compliance";

const now = new Date("2026-11-06T00:00:00Z");
const days = (n: number) => new Date(now.getTime() + n * 24 * 60 * 60 * 1000);

describe("compliance", () => {
	it("caps deposits at five weeks' rent", () => {
		// £695/month → £160.38/week → £801.92 for five weeks.
		expect(depositCapPence(69500)).toBe(80192);
	});

	it("flags certificates due within 30 days by severity", () => {
		const listing = {
			_id: new Types.ObjectId(),
			propertyTitle: "22 Kingsdown Parade",
			gasSafetyExpiry: days(-2),
			eicrExpiry: days(21),
			epcExpiry: days(10),
			hmoLicenceExpiry: days(200)
		};
		const items = sortCompliance(listingCompliance(listing as never, now));
		expect(items.map(i => [i.kind, i.severity])).toEqual([
			["GAS_SAFETY", "high"],
			["EPC", "medium"],
			["EICR", "low"]
		]);
	});

	it("flags an unprotected deposit and one above the cap", () => {
		const tenancy = {
			_id: new Types.ObjectId(),
			listing: new Types.ObjectId(),
			startDate: days(-60),
			depositReceivedAt: days(-26),
			monthlyRent: 69500,
			depositAmount: 90000,
			depositProtectedAt: null
		};
		const items = tenancyCompliance(tenancy as never, undefined, now);
		expect(items.map(i => i.kind).sort()).toEqual(["DEPOSIT_OVER_CAP", "DEPOSIT_UNPROTECTED"]);
		const unprotected = items.find(i => i.kind === "DEPOSIT_UNPROTECTED")!;
		expect(unprotected.severity).toBe("medium");
		// 30 days from receipt, not from the start date (which would be 30 days ago).
		expect(unprotected.dueDate.toISOString()).toBe(new Date(days(-26).getTime() + 30 * 86_400_000).toISOString());
	});

	it("counts the deposit deadline from depositReceivedAt only", () => {
		expect(depositProtectionDeadline({ depositReceivedAt: null })).toBeNull();
		expect(depositProtectionDeadline({ depositReceivedAt: new Date("2026-10-01T00:00:00Z") })!.toISOString()).toBe(
			"2026-10-31T00:00:00.000Z"
		);
		const items = tenancyCompliance(
			{ _id: new Types.ObjectId(), listing: new Types.ObjectId(), startDate: days(-60), monthlyRent: 69500, depositAmount: 50000, depositProtectedAt: null } as never,
			undefined,
			now
		);
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ kind: "DEPOSIT_NOT_YET_RECEIVED", severity: "low" });
	});
});

describe("compliance in Scotland", () => {
	const listing = { _id: new Types.ObjectId(), propertyTitle: "3 North Street", nation: "SCOTLAND" };

	it("caps the deposit at two months' rent and skips the English holding-deposit cap", () => {
		expect(depositCapPence(65000, "SCOTLAND")).toBe(130000);
		const items = listingCompliance({ ...listing, monthlyRent: 650, numOfPeople: 1, securityDeposit: 1300, holdingDeposit: 300 });
		expect(items).toEqual([]);
	});

	it("counts 30 working days from the start of the tenancy, without a receipt date", () => {
		const tenancy = { _id: new Types.ObjectId(), listing: listing._id, startDate: new Date("2026-09-01T00:00:00Z"), monthlyRent: 65000, depositAmount: 130000 };
		expect(depositProtectionDeadline(tenancy, "SCOTLAND")).toEqual(new Date("2026-10-13T00:00:00Z"));
		const [item] = tenancyCompliance(tenancy, listing, new Date("2026-10-20T00:00:00Z"));
		expect(item.kind).toBe("DEPOSIT_UNPROTECTED");
		expect(item.message).toBe("Deposit is not protected and the 30-working-day deadline has passed.");
	});
});
