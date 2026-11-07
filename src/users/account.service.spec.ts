import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { Types } from "mongoose";
import { AccountService } from "./account.service";
import { TeamScope } from "./types/team-scope";

const lean = <T>(value: T) => ({ lean: () => ({ exec: () => Promise.resolve(value) }) });
const selectLean = <T>(value: T) => ({ select: () => lean(value) });

function setup() {
	const userModel = {
		findById: jest.fn(),
		find: jest.fn((): unknown => lean([])),
		findOne: jest.fn((): unknown => selectLean(null)),
		updateOne: jest.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
		updateMany: jest.fn().mockResolvedValue({})
	};
	const tenancyModel = { find: jest.fn((): unknown => selectLean([])) };
	const paymentModel = { exists: jest.fn().mockResolvedValue(null) };
	const service = new AccountService(userModel as any, tenancyModel as any, paymentModel as any);
	return { service, userModel, tenancyModel, paymentModel };
}

describe("AccountService team", () => {
	const owner = { _id: new Types.ObjectId(), email: "landlord@example.com" };

	it("invites by email with scopes and never exposes payouts", async () => {
		const { service, userModel } = setup();
		userModel.updateOne.mockResolvedValueOnce({ matchedCount: 0 }).mockResolvedValueOnce({ matchedCount: 1 });
		const member = { _id: new Types.ObjectId(), email: "sam@example.com", scopes: [TeamScope.VIEWINGS_INBOX], user: null, invitedAt: new Date() };
		userModel.findById.mockReturnValue(selectLean({ team: [member] }));

		const result = await service.invite(owner as any, { email: " Sam@Example.com ", scopes: [TeamScope.VIEWINGS_INBOX] });
		expect(userModel.updateOne.mock.calls[1][1].$push.team).toMatchObject({ email: "sam@example.com", scopes: [TeamScope.VIEWINGS_INBOX] });
		expect(result).toMatchObject({ email: "sam@example.com", name: null, canSeePayouts: false, hasAccount: false });
		expect(Object.values(TeamScope)).not.toContain("PAYOUTS");
	});

	it("refuses inviting yourself", async () => {
		const { service } = setup();
		await expect(service.invite(owner as any, { email: "LANDLORD@example.com", scopes: [TeamScope.REPAIRS] })).rejects.toBeInstanceOf(
			BadRequestException
		);
	});
});

describe("AccountService team invites", () => {
	const ownerId = new Types.ObjectId();
	const invitee = { _id: new Types.ObjectId(), email: "b@example.com", isVerified: true };

	it("keeps an invite to an existing account pending instead of binding it", async () => {
		const { service, userModel } = setup();
		userModel.updateOne.mockResolvedValueOnce({ matchedCount: 0 }).mockResolvedValueOnce({ matchedCount: 1 });
		userModel.findById.mockReturnValue(selectLean({ team: [] }));
		userModel.findOne.mockReturnValue(selectLean({ _id: invitee._id }));
		await service.invite({ _id: ownerId, email: "a@example.com" } as any, { email: invitee.email, scopes: [TeamScope.REPAIRS] }).catch(() => null);
		expect(userModel.updateOne.mock.calls[1][1].$push.team.user).toBeNull();
	});

	it("refuses to accept with an unverified email", async () => {
		const { service, userModel } = setup();
		await expect(service.acceptInvite({ ...invitee, isVerified: false } as any, ownerId.toString())).rejects.toBeInstanceOf(ForbiddenException);
		expect(userModel.updateOne).not.toHaveBeenCalled();
	});

	it("binds only the pending invite addressed to the caller's email", async () => {
		const { service, userModel } = setup();
		(userModel as any).exists = jest.fn().mockResolvedValue(null);
		await service.acceptInvite(invitee as any, ownerId.toString());
		const [filter, update] = userModel.updateOne.mock.calls[0];
		expect(filter).toMatchObject({ _id: ownerId, team: { $elemMatch: { email: "b@example.com", user: null } } });
		expect(update).toEqual({ $set: { "team.$.user": invitee._id } });
	});

	it("refuses a second team", async () => {
		const { service, userModel } = setup();
		(userModel as any).exists = jest.fn().mockResolvedValue({ _id: ownerId });
		await expect(service.acceptInvite(invitee as any, ownerId.toString())).rejects.toBeInstanceOf(ConflictException);
	});

	it("leaving pulls the caller from every team", async () => {
		const { service, userModel } = setup();
		userModel.updateMany.mockResolvedValue({ modifiedCount: 1 });
		await service.leaveTeam(invitee._id);
		expect(userModel.updateMany).toHaveBeenCalledWith({ "team.user": invitee._id }, { $pull: { team: { user: invitee._id } } });
	});
});

describe("AccountService deleteAccount", () => {
	it("refuses while an active tenancy has unpaid rent", async () => {
		const { service, tenancyModel, paymentModel, userModel } = setup();
		tenancyModel.find.mockReturnValue(selectLean([{ _id: new Types.ObjectId() }]));
		paymentModel.exists.mockResolvedValue({ _id: new Types.ObjectId() });
		await expect(service.deleteAccount(new Types.ObjectId())).rejects.toBeInstanceOf(ConflictException);
		expect(userModel.updateOne).not.toHaveBeenCalled();
	});

	it("soft deletes: signs out, clears the password and frees the email", async () => {
		const { service, userModel } = setup();
		const id = new Types.ObjectId();
		const result = await service.deleteAccount(id);
		expect(result.deletedAt).toBeInstanceOf(Date);
		const [filter, update] = userModel.updateOne.mock.calls[0];
		expect(filter).toEqual({ _id: id, deletedAt: null });
		expect(update.$set).toMatchObject({ refreshSessions: [], email: `deleted-${id.toString()}@deleted.invalid` });
		expect(update.$unset.password).toBe(1);
	});
});
