import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Types } from "mongoose";
import { Role } from "../auth/role.enum";
import { TeamScope } from "../users/types/team-scope";
import { InboxController } from "../inbox/inbox.controller";
import { ConnectorsService } from "./connectors.service";
import { ConnectionStatus, EmailProvider } from "./email-connection.schema";

const lean = <T>(value: T) => ({ lean: () => ({ exec: () => Promise.resolve(value) }), select: () => lean(value) });

function setup(attachment: Record<string, unknown> = {}, role = Role.STUDENT, from = "tenant@example.com") {
	const me = { _id: new Types.ObjectId(), role };
	const tenancyId = new Types.ObjectId();
	const connectionId = new Types.ObjectId();
	const email = {
		_id: new Types.ObjectId(),
		user: me._id,
		connection: connectionId,
		tenancy: tenancyId,
		from,
		to: [],
		outgoing: false,
		subject: "Your tenancy agreement",
		attachments: [{ name: "Tenancy-agreement.pdf", mimeType: "application/pdf", size: 10, filedAs: null, ...attachment }]
	};
	// Mirrors the real query: only the mailbox owner's own messages are found.
	const messageModel = {
		findOne: jest.fn((q: { user: Types.ObjectId }) => lean(q.user.equals(email.user) ? email : null)),
		updateOne: jest.fn().mockResolvedValue({})
	};
	const connectionModel = {
		findById: jest.fn(() => lean({ _id: connectionId, user: me._id, provider: EmailProvider.DEMO, status: ConnectionStatus.CONNECTED }))
	};
	const tenancy = { _id: tenancyId, landlord: role === Role.LANDLORD_AGENCY ? me._id : new Types.ObjectId(), listing: new Types.ObjectId(), documents: [] };
	// The landlord's account address is landlord@example.com.
	const userModel = { exists: jest.fn(async (q: { $or: { email?: string }[] }) => (q.$or[0].email === "landlord@example.com" ? { _id: tenancy.landlord } : null)) };
	const listingModel = { findById: jest.fn(() => lean({ propertyTitle: "Flat 1" })) };
	const tenancies = { findForMember: jest.fn().mockResolvedValue(tenancy), appendDocument: jest.fn().mockResolvedValue(undefined) };
	const service = new ConnectorsService(
		{ get: () => "test" } as any,
		connectionModel as any,
		messageModel as any,
		{} as any,
		{} as any,
		userModel as any,
		listingModel as any,
		{} as any,
		tenancies as any,
		{} as any,
		{} as any
	);
	return { service, me, email, messageModel, tenancies };
}

describe("ConnectorsService.fileAttachment authorisation", () => {
	it("does not find another user's synced message", async () => {
		const { service, email, tenancies } = setup();
		const stranger = { _id: new Types.ObjectId(), role: Role.STUDENT };
		await expect(service.fileAttachment(stranger, email._id.toString(), 0)).rejects.toBeInstanceOf(NotFoundException);
		expect(tenancies.appendDocument).not.toHaveBeenCalled();
	});

	it("refuses someone who is not a member of the message's tenancy", async () => {
		const { service, me, email, tenancies, messageModel } = setup();
		tenancies.findForMember.mockRejectedValue(new ForbiddenException("You are not part of this tenancy."));
		await expect(service.fileAttachment(me, email._id.toString(), 0)).rejects.toBeInstanceOf(ForbiddenException);
		expect(tenancies.appendDocument).not.toHaveBeenCalled();
		expect(messageModel.updateOne).not.toHaveBeenCalled();
	});

	it("files for a member, and a tenant's 'agreement' is only ever an Other document", async () => {
		const { service, me, email, tenancies, messageModel } = setup();
		const filed = await service.fileAttachment(me, email._id.toString(), 0);
		expect(tenancies.appendDocument).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ type: "OTHER", source: "EMAIL" })
		);
		expect(filed.filedAs).toBe("My home › Documents");
		expect(messageModel.updateOne).toHaveBeenCalled();
	});

	it("does nothing for an attachment that is already filed", async () => {
		const { service, me, email, tenancies } = setup({ filedAs: "My home › Contract" });
		await service.fileAttachment(me, email._id.toString(), 0);
		expect(tenancies.findForMember).not.toHaveBeenCalled();
		expect(tenancies.appendDocument).not.toHaveBeenCalled();
	});
});

describe("ConnectorsService.fileAttachment document type", () => {
	it("files a tenant's 'Re: tenancy agreement' photo in the landlord's mailbox as Other, not as the contract", async () => {
		const { service, me, email, tenancies } = setup({ name: "photo.jpg", mimeType: "image/jpeg" }, Role.LANDLORD_AGENCY);
		email.subject = "Re: tenancy agreement";
		const filed = await service.fileAttachment(me, email._id.toString(), 0);
		expect(tenancies.appendDocument).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: "OTHER" }));
		expect(filed.filedAs).toBe("Flat 1 › Documents");
	});

	it("keeps the contract type when the landlord sent it", async () => {
		const { service, me, email, tenancies } = setup({}, Role.STUDENT, "landlord@example.com");
		await service.fileAttachment(me, email._id.toString(), 0);
		expect(tenancies.appendDocument).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: "TENANCY_AGREEMENT" }));
	});

	it("keeps the contract type for the landlord's own sent mail", async () => {
		const { service, me, email, tenancies } = setup({}, Role.LANDLORD_AGENCY, "landlord@example.com");
		Object.assign(email, { outgoing: true, to: ["tenant@example.com"] });
		await service.fileAttachment(me, email._id.toString(), 0);
		expect(tenancies.appendDocument).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: "TENANCY_AGREEMENT" }));
	});

	it("files a tenant's own agreement sent to a deposit scheme as Other", async () => {
		const { service, me, email, tenancies } = setup();
		Object.assign(email, { outgoing: true, to: ["disputes@depositprotection.com"] });
		await service.fileAttachment(me, email._id.toString(), 0);
		expect(tenancies.appendDocument).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: "OTHER" }));
	});
});

describe("InboxController.fileAttachment team access", () => {
	it("refuses a team member without inbox access, even with tenancies access", async () => {
		const connectors = { fileAttachment: jest.fn() };
		const controller = new InboxController({} as any, connectors as any);
		const owner = { _id: new Types.ObjectId(), role: Role.LANDLORD_AGENCY, actingMember: { scopes: [TeamScope.TENANCIES] } };
		await expect(controller.fileAttachment(new Types.ObjectId().toString(), 0, owner as any)).rejects.toBeInstanceOf(ForbiddenException);
		expect(connectors.fileAttachment).not.toHaveBeenCalled();
	});

	it("lets a team member with inbox access file", async () => {
		const connectors = { fileAttachment: jest.fn().mockResolvedValue({ name: "a.pdf", filedAs: "x" }) };
		const controller = new InboxController({} as any, connectors as any);
		const owner = { _id: new Types.ObjectId(), role: Role.LANDLORD_AGENCY, actingMember: { scopes: [TeamScope.TENANCIES, TeamScope.VIEWINGS_INBOX] } };
		await expect(controller.fileAttachment("m", 0, owner as any)).resolves.toMatchObject({ name: "a.pdf" });
	});
});
