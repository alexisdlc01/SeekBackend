import { PaymentStatus } from "../payments/payment.enums";
import { propertyComplianceStatus, propertyRentStatus } from "./property-rows";

describe("propertyRentStatus", () => {
	it("is NOT_LET without a tenancy", () => {
		expect(propertyRentStatus([], false)).toBe("NOT_LET");
	});

	it("puts late payments first", () => {
		expect(propertyRentStatus([PaymentStatus.PAID, PaymentStatus.LATE], true)).toBe("LATE");
	});

	it("is DUE while anything is still to collect and PAID once everything is in", () => {
		expect(propertyRentStatus([PaymentStatus.PAID, PaymentStatus.PENDING], true)).toBe("DUE");
		expect(propertyRentStatus([PaymentStatus.SCHEDULED], true)).toBe("DUE");
		expect(propertyRentStatus([PaymentStatus.PAID, PaymentStatus.PAID], true)).toBe("PAID");
	});

	it("is NOT_DUE for a let property with nothing due yet", () => {
		expect(propertyRentStatus([], true)).toBe("NOT_DUE");
	});
});

describe("propertyComplianceStatus", () => {
	it("flags overdue items first, then anything coming up", () => {
		expect(propertyComplianceStatus(["low", "high"])).toBe("ACTION_NEEDED");
		expect(propertyComplianceStatus(["medium"])).toBe("DUE_SOON");
		expect(propertyComplianceStatus([])).toBe("OK");
	});
});
