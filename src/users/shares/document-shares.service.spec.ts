import { Types } from "mongoose";
import { DocumentSharesService } from "./document-shares.service";
import { IDENTITY_DOCUMENT_TYPES } from "../types/document-type";

describe("DocumentSharesService.shareForApplication", () => {
	const now = new Date("2026-11-19T10:00:00Z");

	it("refreshes the window without ever clearing a student's revocation", async () => {
		const shareModel = { bulkWrite: jest.fn().mockResolvedValue({}), updateMany: jest.fn().mockResolvedValue({}) };
		const service = new DocumentSharesService(shareModel as never, { updateMany: jest.fn().mockResolvedValue({}) } as never);
		await service.shareForApplication({ ownerIds: [new Types.ObjectId()], viewer: new Types.ObjectId(), application: new Types.ObjectId(), now });
		const { update } = shareModel.bulkWrite.mock.calls[0][0][0].updateOne;
		expect(update.$set).not.toHaveProperty("revokedAt");
		expect(update.$setOnInsert).toEqual({ revokedAt: null });
		expect(update.$set.expiresAt.getTime() - now.getTime()).toBe(14 * 24 * 3_600_000);
	});

	it("reopens only a share Seek closed; a student's own stop stays unless they join again", async () => {
		const shareModel = { bulkWrite: jest.fn().mockResolvedValue({}), updateMany: jest.fn().mockResolvedValue({}), updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 }) };
		const service = new DocumentSharesService(shareModel as never, { updateMany: jest.fn().mockResolvedValue({}) } as never);
		const owner = new Types.ObjectId();
		const application = new Types.ObjectId();

		await service.revokeForApplication(application);
		expect(shareModel.updateMany.mock.calls[0][1].$set.revokedBy).toBe("system");
		await service.revoke(owner.toString(), new Types.ObjectId().toString());
		expect(shareModel.updateOne.mock.calls[0][1].$set.revokedBy).toBe("student");

		await service.shareForApplication({ ownerIds: [owner], viewer: new Types.ObjectId(), application, now });
		expect(shareModel.updateMany.mock.calls[1]).toEqual([
			{ owner: { $in: [owner] }, application, revokedAt: { $ne: null }, revokedBy: "system" },
			{ $set: { revokedAt: null, revokedBy: null } }
		]);
		await service.shareForApplication({ ownerIds: [owner], viewer: new Types.ObjectId(), application, now, reconsent: true });
		expect(shareModel.updateMany.mock.calls[2][0]).not.toHaveProperty("revokedBy");
	});
});

describe("DocumentSharesService identity erasure clock", () => {
	const now = new Date("2026-11-19T10:00:00Z");

	it("sharing stamps lastSharedAt on every owner's identity documents only", async () => {
		const shareModel = { bulkWrite: jest.fn().mockResolvedValue({}), updateMany: jest.fn().mockResolvedValue({}) };
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
