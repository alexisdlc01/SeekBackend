import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { randomUUID } from "crypto";
import { Types } from "mongoose";
import { RepairsService } from "./repairs.service";
import { Role } from "../auth/role.enum";
import { RepairStatus } from "./repair.schema";

describe("RepairsService create", () => {
	const landlordId = new Types.ObjectId();
	const tenantId = new Types.ObjectId();
	const tenancy = { _id: new Types.ObjectId(), landlord: landlordId, tenants: [tenantId] };

	function setup() {
		const repairModel = {
			create: jest.fn(async (doc: Record<string, unknown>) => ({ ...doc, toObject: () => doc }))
		};
		const tenancies = {
			findForLandlord: jest.fn(async (_id: string, viewer: { _id: Types.ObjectId }) => {
				if (viewer._id.toString() !== landlordId.toString()) throw new ForbiddenException();
				return tenancy;
			}),
			findForTenant: jest.fn().mockResolvedValue(tenancy)
		};
		const repairFind = { populate: () => repairFind, sort: () => repairFind, lean: () => repairFind, exec: async () => [{ photoKeys: ["private/a/1.jpg"] }] };
		(repairModel as any).find = jest.fn(() => repairFind);
		const uploads = { getPresignedDownloadUrl: jest.fn(async (key: string) => `https://signed/${key}`) };
		const notifications = { notify: jest.fn(), notifyMany: jest.fn() };
		const service = new RepairsService(repairModel as any, tenancies as any, notifications as any, uploads as any);
		return { service, tenancies, notifications, repairModel, uploads, repairFind };
	}

	it("lets a landlord log a repair on their own tenancy and tells the tenants", async () => {
		const { service, tenancies, notifications } = setup();
		await service.create({ tenancy: tenancy._id.toString(), title: " Boiler service " }, { _id: landlordId, role: Role.LANDLORD_AGENCY } as any);
		expect(tenancies.findForLandlord).toHaveBeenCalled();
		expect(notifications.notifyMany.mock.calls[0][0][0]).toMatchObject({ user: tenantId, link: "/student/home" });
	});

	it("refuses a landlord on someone else's tenancy", async () => {
		const { service, repairModel } = setup();
		await expect(
			service.create({ tenancy: tenancy._id.toString(), title: "Leak" }, { _id: new Types.ObjectId(), role: Role.LANDLORD_AGENCY } as any)
		).rejects.toBeInstanceOf(ForbiddenException);
		expect(repairModel.create).not.toHaveBeenCalled();
	});

	it("still lets a tenant report to the landlord", async () => {
		const { service, tenancies, notifications } = setup();
		await service.create({ tenancy: tenancy._id.toString(), title: "Leak" }, { _id: tenantId, role: Role.STUDENT } as any);
		expect(tenancies.findForTenant).toHaveBeenCalled();
		expect(notifications.notify.mock.calls[0][0].user).toBe(landlordId);
	});

	it("stores photos only when the key was issued to the reporter, max 5", async () => {
		const { service, repairModel } = setup();
		const reporter = { _id: tenantId, role: Role.STUDENT } as any;
		const own = (n: number) => Array.from({ length: n }, (_, i) => `private/${tenantId}/${randomUUID()}.jpg`);
		await service.create({ tenancy: tenancy._id.toString(), title: "Leak", photoKeys: own(5) }, reporter);
		expect(repairModel.create.mock.calls[0][0].photoKeys).toHaveLength(5);
		await expect(service.create({ tenancy: tenancy._id.toString(), title: "Leak", photoKeys: own(6) }, reporter)).rejects.toBeInstanceOf(BadRequestException);
		await expect(
			service.create({ tenancy: tenancy._id.toString(), title: "Leak", photoKeys: [`private/${landlordId}/${randomUUID()}.jpg`] }, reporter)
		).rejects.toBeInstanceOf(BadRequestException);
		await expect(
			service.create({ tenancy: tenancy._id.toString(), title: "Leak", photoKeys: [`private/${tenantId}/${randomUUID()}.pdf`] }, reporter)
		).rejects.toBeInstanceOf(BadRequestException);
		expect(repairModel.create).toHaveBeenCalledTimes(1);
	});

	it("signs photo links only for tenancy members", async () => {
		const { service, tenancies, uploads } = setup();
		(tenancies as any).findForMember = jest.fn(async (_id: string, viewer: { _id: Types.ObjectId }) => {
			if (viewer._id.toString() !== tenantId.toString()) throw new ForbiddenException();
			return tenancy;
		});
		const [repair] = await service.listForTenancy(tenancy._id.toString(), { _id: tenantId, role: Role.STUDENT } as any);
		expect(repair.photoUrls).toEqual(["https://signed/private/a/1.jpg"]);
		await expect(service.listForTenancy(tenancy._id.toString(), { _id: new Types.ObjectId(), role: Role.STUDENT } as any)).rejects.toBeInstanceOf(ForbiddenException);
		expect(uploads.getPresignedDownloadUrl).toHaveBeenCalledTimes(1);
	});

	it("gives a superuser who is not a member no photo links", async () => {
		const { service, tenancies, uploads } = setup();
		(tenancies as any).findForMember = jest.fn().mockResolvedValue(tenancy);
		const [repair] = await service.listForTenancy(tenancy._id.toString(), { _id: new Types.ObjectId(), role: Role.SUPERUSER } as any);
		expect(repair.photoUrls).toEqual([]);
		expect(uploads.getPresignedDownloadUrl).not.toHaveBeenCalled();
	});
});

describe("RepairsService update", () => {
	it("gives the tenants the booked time in London time, not UTC", async () => {
		const landlordId = new Types.ObjectId();
		const tenantId = new Types.ObjectId();
		const tenancy = { _id: new Types.ObjectId(), landlord: landlordId, tenants: [tenantId] };
		const repair = { _id: new Types.ObjectId(), landlord: landlordId, tenancy: tenancy._id, title: "Boiler" };
		// 13:00 UTC in July is 14:00 BST.
		const scheduledFor = new Date("2026-07-15T13:00:00Z");
		const lean = (value: unknown) => ({ lean: () => ({ exec: async () => value }) });
		const repairModel = {
			findById: jest.fn(() => lean(repair)),
			findByIdAndUpdate: jest.fn(() => lean({ ...repair, status: RepairStatus.SCHEDULED, scheduledFor }))
		};
		const notifications = { notify: jest.fn(), notifyMany: jest.fn() };
		const service = new RepairsService(
			repairModel as any,
			{ findForLandlord: jest.fn().mockResolvedValue(tenancy) } as any,
			notifications as any,
			{} as any
		);
		await service.update(repair._id.toString(), { status: RepairStatus.SCHEDULED, scheduledFor: scheduledFor.toISOString() } as any, { _id: landlordId } as any);
		expect(notifications.notifyMany.mock.calls[0][0][0].body).toBe("Booked for Wed 15 Jul, 14:00");
	});
});
