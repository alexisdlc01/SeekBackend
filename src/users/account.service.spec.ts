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
	const tenancyModel = {
		find: jest.fn((): unknown => selectLean([])),
		distinct: jest.fn().mockResolvedValue([]),
		updateMany: jest.fn().mockResolvedValue({})
	};
	const paymentModel = { exists: jest.fn().mockResolvedValue(null) };
	const shareModel = { updateMany: jest.fn().mockResolvedValue({}) };
	const connectionModel = { find: jest.fn((): unknown => selectLean([])) };
	const connectors = { disconnect: jest.fn().mockResolvedValue({}) };
	const uploads = { deletePrivateObject: jest.fn().mockResolvedValue(undefined), deletePublicObject: jest.fn().mockResolvedValue(undefined) };
	const listingModel = { updateMany: jest.fn().mockResolvedValue({}) };
	const messageModel = { distinct: jest.fn().mockResolvedValue([]) };
	const contracts = {
		referencedDocumentKeys: jest.fn().mockResolvedValue([]),
		settleForDeletedTenant: jest.fn().mockResolvedValue(undefined)
	};
	const applications = { releaseDeletedMember: jest.fn().mockResolvedValue(undefined) };
	const mail = { sendTeamInviteEmail: jest.fn().mockResolvedValue(undefined) };
	const service = new AccountService(
		userModel as any,
		tenancyModel as any,
		paymentModel as any,
		shareModel as any,
		connectionModel as any,
		connectors as any,
		uploads as any,
		listingModel as any,
		messageModel as any,
		{ get: (token: { name: string }) => (token.name === "ApplicationService" ? applications : contracts) } as any,
		mail as any
	);
	return { service, userModel, tenancyModel, paymentModel, shareModel, connectionModel, connectors, uploads, listingModel, messageModel, contracts, applications, mail };
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

	it("emails only new invites, and a mail failure does not fail the invite", async () => {
		const { service, userModel, mail } = setup();
		const named = { ...owner, name: "Lee Landlord" };
		userModel.findById.mockReturnValue(selectLean({ team: [] }));

		await service.invite(named as any, { email: "a@example.com", scopes: [TeamScope.REPAIRS] }); // existing member: scopes updated
		expect(mail.sendTeamInviteEmail).not.toHaveBeenCalled();

		userModel.updateOne.mockResolvedValueOnce({ matchedCount: 0 }).mockResolvedValueOnce({ matchedCount: 1 });
		mail.sendTeamInviteEmail.mockRejectedValueOnce(new Error("mailgun down"));
		await expect(service.invite(named as any, { email: "B@example.com", scopes: [TeamScope.REPAIRS] })).resolves.toBeUndefined();
		expect(mail.sendTeamInviteEmail).toHaveBeenCalledWith("b@example.com", "Lee Landlord");
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

	it("refuses while Seek still holds rent collected for the landlord, which a deleted account could never receive", async () => {
		const { service, paymentModel, userModel } = setup();
		const id = new Types.ObjectId();
		paymentModel.exists.mockImplementation(async (filter: any) => (filter.payoutStatus === "HELD" ? { _id: new Types.ObjectId() } : null));
		await expect(service.deleteAccount(id)).rejects.toBeInstanceOf(ConflictException);
		expect(paymentModel.exists).toHaveBeenCalledWith(expect.objectContaining({ landlord: id, status: "PAID", payoutStatus: "HELD" }));
		expect(userModel.updateOne).not.toHaveBeenCalled();
	});

	it("refuses while a payment to the landlord is still in progress, which could complete after deletion", async () => {
		const { service, paymentModel, userModel } = setup();
		const id = new Types.ObjectId();
		paymentModel.exists.mockImplementation(async (filter: any) => (filter.status === "PENDING" ? { _id: new Types.ObjectId() } : null));
		await expect(service.deleteAccount(id)).rejects.toBeInstanceOf(ConflictException);
		expect(paymentModel.exists).toHaveBeenCalledWith(expect.objectContaining({ landlord: id, status: "PENDING", providerRef: /^(cs_|pi_)/ }));
		expect(userModel.updateOne).not.toHaveBeenCalled();
	});

	it("soft deletes: signs out, clears the password and frees the email", async () => {
		const { service, userModel } = setup();
		const id = new Types.ObjectId();
		const result = await service.deleteAccount(id);
		expect(result.deletedAt).toBeInstanceOf(Date);
		const [filter, update] = userModel.updateOne.mock.calls[0];
		expect(filter).toEqual({ _id: id, deletedAt: null });
		expect(update.$set).toMatchObject({ refreshSessions: [], pushTokens: [], email: `deleted-${id.toString()}@deleted.invalid` });
		expect(update.$unset.password).toBe(1);
	});

	it("re-checks co-tenants' contracts once the account is deleted, and a failure there does not fail the deletion", async () => {
		const { service, userModel, contracts } = setup();
		const id = new Types.ObjectId();
		contracts.settleForDeletedTenant.mockRejectedValue(new Error("Mongo blip"));
		await expect(service.deleteAccount(id)).resolves.toHaveProperty("deletedAt");
		expect(contracts.settleForDeletedTenant).toHaveBeenCalledWith(id);
		// After the soft delete, so the deleted tenant is no longer counted nor emailed.
		expect(contracts.settleForDeletedTenant.mock.invocationCallOrder[0]).toBeGreaterThan(userModel.updateOne.mock.invocationCallOrder[0]);
	});

	it("removes the deleted account from its open households, after the soft delete", async () => {
		const { service, userModel, applications } = setup();
		const id = new Types.ObjectId();
		await service.deleteAccount(id);
		expect(applications.releaseDeletedMember).toHaveBeenCalledWith(id);
		expect(applications.releaseDeletedMember.mock.invocationCallOrder[0]).toBeGreaterThan(userModel.updateOne.mock.invocationCallOrder[0]);
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

	it("takes the landlord's published listings offline so nobody applies to a deleted account", async () => {
		const { service, listingModel } = setup();
		const id = new Types.ObjectId();
		await service.deleteAccount(id);
		expect(listingModel.updateMany).toHaveBeenCalledWith(
			{ landlord: id, isDraft: false },
			{ $set: expect.objectContaining({ isVerified: false, moderationStatus: "NEEDS_CHANGES" }) }
		);
	});

	it("calls off tenancies still waiting on invites, so they never stay stuck or bill a deleted account", async () => {
		const { service, tenancyModel } = setup();
		const id = new Types.ObjectId();
		await service.deleteAccount(id);
		expect(tenancyModel.updateMany).toHaveBeenCalledWith(
			{ status: "PENDING_ACCEPTANCE", $or: [{ tenants: id }, { pendingTenants: id }, { landlord: id }] },
			{ $set: { status: "ENDED" } }
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
		expect(update.$unset).toMatchObject({
			dateOfBirth: 1, profilePicUrl: 1, universityDetails: 1, university: 1,
			companyName: 1, registrations: 1, notificationPrefs: 1, rentReminderSchedule: 1,
			connectorSettings: 1, payoutBank: 1
		});
	});

	it("never deletes a repair photo: repairs stay with the property history and the user shows as Deleted user", async () => {
		const { service, userModel, uploads } = setup();
		const id = new Types.ObjectId();
		const passport = `private/${id.toString()}/a.pdf`;
		const repairPhoto = `private/${id.toString()}/repairs/x.jpg`;
		userModel.findById.mockReturnValue(selectLean({ documents: [{ key: passport }] }));
		await service.deleteAccount(id);
		expect(uploads.deletePrivateObject).not.toHaveBeenCalledWith(repairPhoto);
		expect(uploads.deletePrivateObject).toHaveBeenCalledTimes(1);
		expect(userModel.updateOne.mock.calls[0][1].$set).toMatchObject({ name: "Deleted user" });
	});

	it("deletes unfiled imported email attachments but keeps one referenced by a tenancy", async () => {
		const { service, messageModel, tenancyModel, uploads } = setup();
		const id = new Types.ObjectId();
		const unfiled = `private/${id}/mail.pdf`;
		const filed = `private/${id}/agreement.pdf`;
		messageModel.distinct.mockResolvedValueOnce([unfiled, filed, null]).mockResolvedValueOnce([]);
		tenancyModel.distinct.mockResolvedValue([filed]);

		await service.deleteAccount(id);

		expect(messageModel.distinct).toHaveBeenCalledWith("attachments.key", { user: id, "attachments.key": { $type: "string" } });
		expect(uploads.deletePrivateObject).toHaveBeenCalledTimes(1);
		expect(uploads.deletePrivateObject).toHaveBeenCalledWith(unfiled);
	});

	it("keeps private objects still referenced by a contract or another email message", async () => {
		const { service, userModel, messageModel, contracts, uploads } = setup();
		const id = new Types.ObjectId();
		const contractKey = `private/${id}/contract.pdf`;
		const sharedEmailKey = `private/${id}/shared.pdf`;
		const orphanKey = `private/${id}/orphan.pdf`;
		userModel.findById.mockReturnValue(selectLean({
			documents: [{ key: contractKey }, { key: sharedEmailKey }, { key: orphanKey }]
		}));
		contracts.referencedDocumentKeys.mockResolvedValue([contractKey]);
		messageModel.distinct
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([sharedEmailKey]);

		await service.deleteAccount(id);

		expect(uploads.deletePrivateObject).toHaveBeenCalledTimes(1);
		expect(uploads.deletePrivateObject).toHaveBeenCalledWith(orphanKey);
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
