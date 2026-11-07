import { ForbiddenException } from "@nestjs/common";
import { Types } from "mongoose";
import { RepairsService } from "./repairs.service";
import { Role } from "../auth/role.enum";

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
		const notifications = { notify: jest.fn(), notifyMany: jest.fn() };
		const service = new RepairsService(repairModel as any, tenancies as any, notifications as any);
		return { service, tenancies, notifications, repairModel };
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
});
