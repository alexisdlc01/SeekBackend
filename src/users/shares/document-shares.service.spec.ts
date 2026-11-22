import { ConflictException, NotFoundException } from "@nestjs/common";
import { Types } from "mongoose";
import { DocumentSharesService } from "./document-shares.service";
import { IDENTITY_DOCUMENT_TYPES } from "../types/document-type";

describe("DocumentSharesService.shareForApplication", () => {
	const now = new Date("2026-11-19T10:00:00Z");

	it("refreshes the window without ever clearing a student's revocation", async () => {
		const shareModel = { bulkWrite: jest.fn().mockResolvedValue({}), updateMany: jest.fn().mockResolvedValue({}) };
		const service = new DocumentSharesService(shareModel as never, { updateMany: jest.fn().mockResolvedValue({}) } as never, {} as never);
		await service.shareForApplication({ ownerIds: [new Types.ObjectId()], viewer: new Types.ObjectId(), application: new Types.ObjectId(), now });
		const { update } = shareModel.bulkWrite.mock.calls[0][0][0].updateOne;
		expect(update.$set).not.toHaveProperty("revokedAt");
		expect(update.$setOnInsert).toEqual({ revokedAt: null });
		expect(update.$set.expiresAt.getTime() - now.getTime()).toBe(14 * 24 * 3_600_000);
	});

	it("reopens only a share Seek closed; a student's own stop stays unless they join again", async () => {
		const shareModel = { bulkWrite: jest.fn().mockResolvedValue({}), updateMany: jest.fn().mockResolvedValue({}), updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 }) };
		const service = new DocumentSharesService(shareModel as never, { updateMany: jest.fn().mockResolvedValue({}) } as never, {} as never);
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
		const service = new DocumentSharesService(shareModel as never, userModel as never, {} as never);
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
		const service = new DocumentSharesService(shareModel as never, userModel as never, {} as never);
		const owner = new Types.ObjectId();
		await service.markIdentitySharedIfActive(owner, now);
		expect(userModel.updateMany).not.toHaveBeenCalled();
		await service.markIdentitySharedIfActive(owner, now);
		expect(shareModel.exists).toHaveBeenCalledWith({ owner, revokedAt: null, expiresAt: { $gt: now } });
		expect(userModel.updateMany).toHaveBeenCalledTimes(1);
	});
});

describe("DocumentSharesService.reopen", () => {
	const now = new Date("2026-11-22T10:00:00Z");
	const lean = <T>(value: T) => ({ lean: () => ({ exec: () => Promise.resolve(value) }) });

	function build(share: Record<string, unknown> | null, applicationOpen = true) {
		const shareModel: any = {
			// The reopen filter carries owner + revokedBy "student": a row matching neither is "not found".
			findOne: jest.fn((filter: { owner: Types.ObjectId; revokedBy: string }) =>
				lean(share && String(share.owner) === String(filter.owner) && share.revokedBy === filter.revokedBy ? share : null)
			),
			updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 }),
			find: jest.fn(() => {
				const query: any = { populate: () => query, sort: () => query, ...lean([{ ...share, revokedAt: null, revokedBy: null, expiresAt: new Date(now.getTime() + 14 * 86_400_000) }]) };
				return query;
			})
		};
		const userModel = { updateMany: jest.fn().mockResolvedValue({}) };
		const applicationModel = { exists: jest.fn().mockResolvedValue(applicationOpen ? { _id: share?.application } : null) };
		return { service: new DocumentSharesService(shareModel, userModel as never, applicationModel as never), shareModel, userModel, applicationModel };
	}

	it("reopens the student's own stop for a fresh window and restarts the identity clock", async () => {
		const owner = new Types.ObjectId();
		const share = { _id: new Types.ObjectId(), owner, viewer: new Types.ObjectId(), application: new Types.ObjectId(), revokedAt: new Date("2026-11-20"), revokedBy: "student", expiresAt: new Date("2026-11-25") };
		const { service, shareModel, userModel, applicationModel } = build(share);
		const view = await service.reopen(owner.toString(), share._id.toString(), now);
		expect(applicationModel.exists.mock.calls[0][0]).toMatchObject({ _id: share.application, applicants: owner, stage: { $nin: ["REJECTED", "WITHDRAWN"] } });
		const [filter, update] = shareModel.updateOne.mock.calls[0];
		expect(filter).toEqual({ _id: share._id, owner, revokedBy: "student" });
		expect(update.$set).toMatchObject({ revokedAt: null, revokedBy: null });
		expect(update.$set.expiresAt.getTime() - now.getTime()).toBe(14 * 24 * 3_600_000);
		expect(userModel.updateMany).toHaveBeenCalledTimes(1);
		expect(view).toMatchObject({ _id: share._id.toString(), revokedAt: null, revokedBy: null, active: true });
	});

	it("is 404 for a share Seek closed (system) and for another student's share", async () => {
		const owner = new Types.ObjectId();
		const system = { _id: new Types.ObjectId(), owner, revokedBy: "system", expiresAt: now };
		await expect(build(system).service.reopen(owner.toString(), system._id.toString(), now)).rejects.toBeInstanceOf(NotFoundException);
		const mine = { _id: new Types.ObjectId(), owner, revokedBy: "student", expiresAt: now };
		const { service, shareModel } = build(mine);
		await expect(service.reopen(new Types.ObjectId().toString(), mine._id.toString(), now)).rejects.toBeInstanceOf(NotFoundException);
		expect(shareModel.updateOne).not.toHaveBeenCalled();
	});

	it("is 409 when the linked application is closed", async () => {
		const owner = new Types.ObjectId();
		const share = { _id: new Types.ObjectId(), owner, application: new Types.ObjectId(), revokedBy: "student", expiresAt: now };
		const { service, shareModel } = build(share, false);
		await expect(service.reopen(owner.toString(), share._id.toString(), now)).rejects.toBeInstanceOf(ConflictException);
		expect(shareModel.updateOne).not.toHaveBeenCalled();
	});
});
