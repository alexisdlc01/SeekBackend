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
});
