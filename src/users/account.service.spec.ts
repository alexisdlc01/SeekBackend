import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { Types } from "mongoose";
import { AccountService } from "./account.service";
import { TeamScope } from "./types/team-scope";

const lean = <T>(value: T) => ({ lean: () => ({ exec: () => Promise.resolve(value) }) });
const selectLean = <T>(value: T) => ({ select: () => lean(value) });

function setup() {
	const userModel = {
		findById: jest.fn((): unknown => selectLean(null)),
		find: jest.fn((): unknown => lean([])),
		findOne: jest.fn((): unknown => selectLean(null)),
		updateOne: jest.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
		updateMany: jest.fn().mockResolvedValue({})
	};
	const tenancyModel = { find: jest.fn((): unknown => selectLean([])), distinct: jest.fn().mockResolvedValue([]) };
	const paymentModel = { exists: jest.fn().mockResolvedValue(null) };
	const shareModel = { updateMany: jest.fn().mockResolvedValue({}) };
	const connectionModel = { find: jest.fn((): unknown => selectLean([])) };
	const connectors = { disconnect: jest.fn().mockResolvedValue({}) };
	const uploads = { deletePrivateObject: jest.fn().mockResolvedValue(undefined), deletePublicObject: jest.fn().mockResolvedValue(undefined) };
	const service = new AccountService(
		userModel as any,
		tenancyModel as any,
		paymentModel as any,
		shareModel as any,
		connectionModel as any,
		connectors as any,
		uploads as any
	);
	return { service, userModel, tenancyModel, paymentModel, shareModel, connectionModel, connectors, uploads };
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

	it("disconnects every mailbox and revokes landlord shares before closing the account", async () => {
		const { service, connectionModel, connectors, shareModel } = setup();
		const id = new Types.ObjectId();
		const gmail = new Types.ObjectId();
		const imap = new Types.ObjectId();
		connectionModel.find.mockReturnValue(selectLean([{ _id: gmail }, { _id: imap }]));
		await service.deleteAccount(id);
		expect(connectionModel.find).toHaveBeenCalledWith({ user: id, status: { $ne: "DISCONNECTED" } });
		expect(connectors.disconnect).toHaveBeenCalledWith({ _id: id }, gmail.toString());
		expect(connectors.disconnect).toHaveBeenCalledWith({ _id: id }, imap.toString());
		expect(shareModel.updateMany).toHaveBeenCalledWith(
			{ owner: id, revokedAt: null },
			{ $set: { revokedAt: expect.any(Date) } }
		);
	});

	it("erases passport files and identity fields but keeps a file filed on a tenancy", async () => {
		const { service, userModel, tenancyModel, uploads } = setup();
		const id = new Types.ObjectId();
		const passport = `private/${id.toString()}/a.pdf`;
		const agreement = `private/${id.toString()}/b.pdf`;
		userModel.findById.mockReturnValue(selectLean({ documents: [{ key: passport }, { key: agreement }, { key: undefined }] }));
		tenancyModel.distinct.mockResolvedValue([agreement]);
		await service.deleteAccount(id);
		expect(uploads.deletePrivateObject).toHaveBeenCalledTimes(1);
		expect(uploads.deletePrivateObject).toHaveBeenCalledWith(passport);
		const update = userModel.updateOne.mock.calls[0][1];
		expect(update.$set).toMatchObject({ name: "Deleted user", documents: [], referenceRequests: [] });
		expect(update.$unset).toMatchObject({ dateOfBirth: 1, profilePicUrl: 1, universityDetails: 1, university: 1 });
	});

	it("erases the uploaded avatar from S3 but not a foreign avatar URL", async () => {
		const { service, userModel, uploads } = setup();
		const id = new Types.ObjectId();
		const key = `public/${id.toString()}/11111111-1111-1111-1111-111111111111.png`;
		userModel.findById.mockReturnValue(selectLean({ profilePicUrl: `https://b.s3.eu-west-2.amazonaws.com/${key}` }));
		await service.deleteAccount(id);
		expect(uploads.deletePublicObject).toHaveBeenCalledWith(key);
		userModel.findById.mockReturnValue(selectLean({ profilePicUrl: "https://lh3.googleusercontent.com/a/abc" }));
		await service.deleteAccount(id);
		expect(uploads.deletePublicObject).toHaveBeenCalledTimes(1);
	});

	it("leaves the account untouched when erasing a file fails, so it can be retried", async () => {
		const { service, userModel, uploads } = setup();
		const id = new Types.ObjectId();
		userModel.findById.mockReturnValue(selectLean({ documents: [{ key: `private/${id.toString()}/a.pdf` }] }));
		uploads.deletePrivateObject.mockRejectedValue(new Error("S3 down"));
		await expect(service.deleteAccount(id)).rejects.toThrow("S3 down");
		expect(userModel.updateOne).not.toHaveBeenCalled();
	});
});
