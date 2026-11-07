import { allTenantsSigned } from "./signing";

describe("allTenantsSigned", () => {
	it("needs every tenant's signature", () => {
		expect(allTenantsSigned(["a", "b"], [{ user: "a" }])).toBe(false);
		expect(allTenantsSigned(["a", "b"], [{ user: "b" }, { user: "a" }])).toBe(true);
		expect(allTenantsSigned([], [])).toBe(false);
	});
});
