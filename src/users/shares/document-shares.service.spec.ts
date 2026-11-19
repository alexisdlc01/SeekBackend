import { Types } from "mongoose";
import { DocumentSharesService } from "./document-shares.service";

describe("DocumentSharesService.shareForApplication", () => {
	it("refreshes the window without ever clearing a student's revocation", async () => {
		const shareModel = { bulkWrite: jest.fn().mockResolvedValue({}) };
		const service = new DocumentSharesService(shareModel as never);
		const now = new Date("2026-11-19T10:00:00Z");
		await service.shareForApplication({ ownerIds: [new Types.ObjectId()], viewer: new Types.ObjectId(), application: new Types.ObjectId(), now });
		const { update } = shareModel.bulkWrite.mock.calls[0][0][0].updateOne;
		expect(update.$set).not.toHaveProperty("revokedAt");
		expect(update.$setOnInsert).toEqual({ revokedAt: null });
		expect(update.$set.expiresAt.getTime() - now.getTime()).toBe(14 * 24 * 3_600_000);
	});
});
