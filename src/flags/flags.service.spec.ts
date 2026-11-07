import { FlagsService } from "./flags.service";

describe("FlagsService", () => {
	it("returns moderation reports from the model", async () => {
		const reports = [{ _id: "flag-1" }];
		const flagModel = {
			find: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(reports) })
		};
		const service = new FlagsService(
			flagModel as never,
			{} as never,
			{} as never
		);

		await expect(service.getAll()).resolves.toBe(reports);
	});

	it("keeps the stored flag when the admin email fails", async () => {
		const stored = { _id: "flag-2", text: "spam" };
		const flagModel = { create: jest.fn().mockResolvedValue({ ...stored, toObject: () => stored }) };
		const userModel = { exists: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({ _id: "u" }) }) };
		const mailService = { sendFlagCreatedEmail: jest.fn().mockRejectedValue(new Error("Mailgun 401")) };
		const service = new FlagsService(flagModel as never, userModel as never, mailService as never);
		jest.spyOn((service as any).logger, "error").mockImplementation(() => undefined);

		await expect(
			service.create({ reportedUser: "64b64b64b64b64b64b64b64b", text: "spam" } as never, { _id: "u", email: "a@st-andrews.ac.uk" } as never)
		).resolves.toBe(stored);
	});
});
