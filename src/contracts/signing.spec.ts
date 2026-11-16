import { allTenantsSigned } from "./signing";

describe("allTenantsSigned", () => {
	it("needs every tenant's signature", () => {
		expect(allTenantsSigned({ tenants: ["a", "b"] }, [{ user: "a" }])).toBe(false);
		expect(allTenantsSigned({ tenants: ["a", "b"] }, [{ user: "b" }, { user: "a" }])).toBe(true);
		expect(allTenantsSigned({ tenants: [] }, [])).toBe(false);
	});

	it("waits for invited housemates who have not accepted yet", () => {
		expect(allTenantsSigned({ tenants: ["a"], pendingTenants: ["b"] }, [{ user: "a" }])).toBe(false);
		expect(allTenantsSigned({ tenants: ["a"], pendingTenants: [] }, [{ user: "a" }])).toBe(true);
	});
});
