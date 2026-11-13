import { registrationStatus, withRegistrationStatus } from "./users.schema";
import { RegistrationKind, RegistrationStatus } from "./types/landlord-registration";

describe("landlord registration format check", () => {
	it("accepts a Landlord Registration Scotland number like 123456/789/12345 and rejects other shapes", () => {
		expect(registrationStatus(RegistrationKind.LANDLORD_REGISTRATION_SCOTLAND, " 123456/789/12345 ")).toBe(RegistrationStatus.DECLARED);
		expect(registrationStatus(RegistrationKind.LANDLORD_REGISTRATION_SCOTLAND, "123456")).toBe(RegistrationStatus.INVALID_FORMAT);
		expect(registrationStatus(RegistrationKind.LANDLORD_REGISTRATION_SCOTLAND, "LRS-ABC")).toBe(RegistrationStatus.INVALID_FORMAT);
	});

	it("is permissive but structural for other kinds", () => {
		expect(registrationStatus(RegistrationKind.HMO_LICENCE, "HMO/FIFE/2024/0123")).toBe(RegistrationStatus.DECLARED);
		expect(registrationStatus(RegistrationKind.HMO_LICENCE, "n/a")).toBe(RegistrationStatus.INVALID_FORMAT);
		expect(registrationStatus(RegistrationKind.OTHER, "x")).toBe(RegistrationStatus.INVALID_FORMAT);
	});

	it("sets the status on every saved registration", () => {
		const update = { $set: { registrations: [{ kind: RegistrationKind.LANDLORD_REGISTRATION_SCOTLAND, number: "12/3", verified: false }] } };
		withRegistrationStatus(update as never);
		expect(update.$set.registrations[0]).toEqual(expect.objectContaining({ status: RegistrationStatus.INVALID_FORMAT }));
	});
});
