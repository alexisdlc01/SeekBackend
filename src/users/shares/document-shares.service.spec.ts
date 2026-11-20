import { Types } from "mongoose";
import { DocumentSharesService } from "./document-shares.service";
import { IDENTITY_DOCUMENT_TYPES } from "../types/document-type";

describe("DocumentSharesService.shareForApplication", () => {
	it("refreshes the window without ever clearing a student's revocation", async () => {
		const shareModel = { bulkWrite: jest.fn().mockResolvedValue({}) };
		const service = new DocumentSharesService(shareModel as never, { updateMany: jest.fn().mockResolvedValue({}) } as never);
		const now = new Date("2026-11-19T10:00:00Z");
		await service.shareForApplication({ ownerIds: [new Types.ObjectId()], viewer: new Types.ObjectId(), application: new Types.ObjectId(), now });
		const { update } = shareModel.bulkWrite.mock.calls[0][0][0].updateOne;
		expect(update.$set).not.toHaveProperty("revokedAt");
		expect(update.$setOnInsert).toEqual({ revokedAt: null });
		expect(update.$set.expiresAt.getTime() - now.getTime()).toBe(14 * 24 * 3_600_000);
	});
});

describe("DocumentSharesService identity erasure clock", () => {
	const now = new Date("2026-11-19T10:00:00Z");

	it("sharing stamps lastSharedAt on every owner's identity documents only", async () => {
		const shareModel = { bulkWrite: jest.fn().mockResolvedValue({}) };
		const userModel = { updateMany: jest.fn().mockResolvedValue({}) };
		const service = new DocumentSharesService(shareModel as never, userModel as never);
		const owner = new Types.ObjectId();
		await service.shareForApplication({ ownerIds: [owner], viewer: new Types.ObjectId(), application: new Types.ObjectId(), now });
		expect(userModel.updateMany).toHaveBeenCalledWith(
			{ _id: { $in: [owner] } },
			{ $set: { "documents.$[doc].lastSharedAt": now } },
			{ arrayFilters: [{ "doc.type": { $in: IDENTITY_DOCUMENT_TYPES } }] }
		);
	});

	it("an upload stamps the clock only while a share is live", async () => {
		const userModel = { updateMany: jest.fn().mockResolvedValue({}) };
		const shareModel = { exists: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ _id: new Types.ObjectId() }) };
		const service = new DocumentSharesService(shareModel as never, userModel as never);
		const owner = new Types.ObjectId();
		await service.markIdentitySharedIfActive(owner, now);
		expect(userModel.updateMany).not.toHaveBeenCalled();
		await service.markIdentitySharedIfActive(owner, now);
		expect(shareModel.exists).toHaveBeenCalledWith({ owner, revokedAt: null, expiresAt: { $gt: now } });
		expect(userModel.updateMany).toHaveBeenCalledTimes(1);
	});
});
