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
			// The reopen filter carries owner + ($or: student's stop | expired, never revoked): a row matching neither is "not found".
			findOne: jest.fn((filter: { owner: Types.ObjectId; $or: { revokedBy?: string; expiresAt?: { $lte: Date } }[] }) =>
				lean(
					share &&
						String(share.owner) === String(filter.owner) &&
						filter.$or.some(c => (c.revokedBy ? share.revokedBy === c.revokedBy : !share.revokedAt && !share.revokedBy && (share.expiresAt as Date) <= c.expiresAt!.$lte))
						? share
						: null
				)
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
		expect(filter).toEqual({ _id: share._id, owner, $or: [{ revokedBy: "student" }, { revokedAt: null, revokedBy: null, expiresAt: { $lte: now } }] });
		expect(update.$set).toMatchObject({ revokedAt: null, revokedBy: null });
		expect(update.$set.expiresAt.getTime() - now.getTime()).toBe(14 * 24 * 3_600_000);
		expect(userModel.updateMany).toHaveBeenCalledTimes(1);
		expect(view).toMatchObject({ _id: share._id.toString(), revokedAt: null, revokedBy: null, active: true });
	});

	it("renews a share whose 14-day window lapsed without anyone revoking it", async () => {
		const owner = new Types.ObjectId();
		const share = { _id: new Types.ObjectId(), owner, viewer: new Types.ObjectId(), application: new Types.ObjectId(), revokedAt: null, revokedBy: null, expiresAt: new Date("2026-11-10") };
		const { service, shareModel, userModel } = build(share);
		const view = await service.reopen(owner.toString(), share._id.toString(), now);
		const [, update] = shareModel.updateOne.mock.calls[0];
		expect(update.$set).toMatchObject({ revokedAt: null, revokedBy: null });
		expect(update.$set.expiresAt.getTime() - now.getTime()).toBe(14 * 24 * 3_600_000);
		expect(userModel.updateMany).toHaveBeenCalledTimes(1);
		expect(view).toMatchObject({ _id: share._id.toString(), active: true });
	});

	it("is 404 for a share that is still live, and for an expired share Seek closed (system)", async () => {
		const owner = new Types.ObjectId();
		const live = { _id: new Types.ObjectId(), owner, revokedAt: null, revokedBy: null, expiresAt: new Date("2026-11-30") };
		const lapsedSystem = { _id: new Types.ObjectId(), owner, revokedAt: new Date("2026-11-01"), revokedBy: "system", expiresAt: new Date("2026-11-10") };
		for (const share of [live, lapsedSystem]) {
			const { service, shareModel } = build(share);
			await expect(service.reopen(owner.toString(), share._id.toString(), now)).rejects.toBeInstanceOf(NotFoundException);
			expect(shareModel.updateOne).not.toHaveBeenCalled();
		}
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

describe("DocumentSharesService.listForOwner", () => {
	it("hides a student's stop once its application is closed, keeps the rest", async () => {
		const now = new Date("2026-11-22T10:00:00Z");
		const owner = new Types.ObjectId();
		const [openApp, closedApp] = [new Types.ObjectId(), new Types.ObjectId()];
		const row = (application: Types.ObjectId | null, revokedBy: string | null) => ({ _id: new Types.ObjectId(), owner, viewer: new Types.ObjectId(), application, revokedBy, revokedAt: revokedBy ? now : null, expiresAt: now });
		const shares = [row(openApp, "student"), row(closedApp, "student"), row(closedApp, "system"), row(null, "student")];
		const query: any = { populate: () => query, sort: () => query, lean: () => ({ exec: () => Promise.resolve(shares) }) };
		const applicationModel = { distinct: jest.fn().mockResolvedValue([openApp]) };
		const service = new DocumentSharesService({ find: () => query } as never, {} as never, applicationModel as never);
		const list = await service.listForOwner(owner.toString(), now);
		expect(applicationModel.distinct.mock.calls[0][1]).toMatchObject({ _id: { $in: [openApp, closedApp] }, applicants: owner, stage: { $nin: ["REJECTED", "WITHDRAWN"] } });
		expect(list.map(item => item._id)).toEqual([shares[0], shares[2], shares[3]].map(share => share._id.toString()));
	});

	it("hides an expired share of a closed application, keeps an expired share of an open one", async () => {
		const now = new Date("2026-11-22T10:00:00Z");
		const owner = new Types.ObjectId();
		const [openApp, closedApp] = [new Types.ObjectId(), new Types.ObjectId()];
		const expired = (application: Types.ObjectId) => ({ _id: new Types.ObjectId(), owner, viewer: new Types.ObjectId(), application, revokedBy: null, revokedAt: null, expiresAt: new Date("2026-11-10") });
		const shares = [expired(openApp), expired(closedApp)];
		const query: any = { populate: () => query, sort: () => query, lean: () => ({ exec: () => Promise.resolve(shares) }) };
		const applicationModel = { distinct: jest.fn().mockResolvedValue([openApp]) };
		const service = new DocumentSharesService({ find: () => query } as never, {} as never, applicationModel as never);
		const list = await service.listForOwner(owner.toString(), now);
		expect(list.map(item => item._id)).toEqual([shares[0]._id.toString()]);
		expect(list[0]).toMatchObject({ active: false, revokedBy: null });
	});
});
