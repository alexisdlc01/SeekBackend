import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { Types } from "mongoose";
import { Role } from "../auth/role.enum";
import { TeamScope } from "../users/types/team-scope";
import { InboxController } from "../inbox/inbox.controller";
import { ConnectorsService } from "./connectors.service";
import { ConnectionStatus, EmailProvider } from "./email-connection.schema";

const lean = <T>(value: T) => ({ lean: () => ({ exec: () => Promise.resolve(value) }), select: () => lean(value) });

function setup(attachment: Record<string, unknown> = {}, role = Role.STUDENT, from = "tenant@example.com", provider = EmailProvider.DEMO) {
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
		findById: jest.fn(() => lean({ _id: connectionId, user: me._id, provider, status: ConnectionStatus.CONNECTED }))
	};
	const tenancy = { _id: tenancyId, landlord: role === Role.LANDLORD_AGENCY ? me._id : new Types.ObjectId(), listing: new Types.ObjectId(), documents: [] };
	// The landlord's account address is landlord@example.com; agent@example.com is on their team.
	const userModel = {
		exists: jest.fn(async (q: { $or: Record<string, string>[] }) =>
			q.$or[0].email === "landlord@example.com" || q.$or[1]["team.email"] === "agent@example.com" ? { _id: tenancy.landlord } : null
		)
	};
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
		{} as any,
		{} as any
	);
	// A real mailbox: the attachment is re-read from Gmail, with what Gmail says about the sender.
	const getFull = jest.fn(async () => ({ from, attachments: [{ name: "Tenancy-agreement.pdf", mimeType: "application/pdf", size: 10, load: async () => Buffer.from("%PDF") }], senderAuthenticated: false, sent: false }));
	Object.assign(service as any, { clients: { [EmailProvider.GMAIL]: { getFull } }, accessToken: async () => "token" });
	jest.spyOn(service as any, "storeFile").mockResolvedValue({ url: "https://files.example/a.pdf", key: "k" });
	return { service, me, email, messageModel, tenancies, getFull };
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

	it("finds the home through the conversation's application for mail stored before the tenancy existed", async () => {
		const { service, me, email, tenancies } = setup();
		const tenancyId = email.tenancy;
		const applicationId = new Types.ObjectId();
		Object.assign(email, { tenancy: null, conversation: new Types.ObjectId() });
		const applicationModel = { findOne: jest.fn(() => lean({ _id: applicationId })) };
		const tenancyModel = { findOne: jest.fn(() => lean({ _id: tenancyId })) };
		Object.assign(service as any, { applicationModel, tenancyModel });
		await service.fileAttachment(me, email._id.toString(), 0);
		expect(applicationModel.findOne).toHaveBeenCalledWith({ conversation: (email as any).conversation });
		expect(tenancyModel.findOne).toHaveBeenCalledWith({ application: applicationId });
		// Membership is still checked on the tenancy found.
		expect(tenancies.findForMember).toHaveBeenCalledWith(tenancyId.toString(), me);
		expect(tenancies.appendDocument).toHaveBeenCalled();
	});

	it("still refuses mail with neither a tenancy nor a conversation leading to one", async () => {
		const { service, me, email, tenancies } = setup();
		Object.assign(email, { tenancy: null, conversation: new Types.ObjectId() });
		Object.assign(service as any, { applicationModel: { findOne: jest.fn(() => lean(null)) } });
		await expect(service.fileAttachment(me, email._id.toString(), 0)).rejects.toBeInstanceOf(BadRequestException);
		expect(tenancies.findForMember).not.toHaveBeenCalled();
	});

	it("does nothing for an attachment that is already filed", async () => {
		const { service, me, email, tenancies } = setup({ filedAs: "My home › Contract" });
		await service.fileAttachment(me, email._id.toString(), 0);
		expect(tenancies.findForMember).not.toHaveBeenCalled();
		expect(tenancies.appendDocument).not.toHaveBeenCalled();
	});
});

describe("ConnectorsService.fileAttachment document type", () => {
	it("does not let tenant evidence suppress a later official document with the same title", async () => {
		const { service, tenancies } = setup();
		const tenancy = {
			_id: new Types.ObjectId(),
			documents: [
				{ type: "TENANCY_AGREEMENT", title: "Tenancy agreement", confirmedByLandlord: false },
				{ type: "INVENTORY", title: "Check in inventory", uploaderRole: Role.STUDENT }
			]
		};

		await (service as any).fileDocument(tenancy, "TENANCY_AGREEMENT", "Tenancy-agreement.pdf", { url: "https://files.example/contract.pdf", key: null }, true);
		await (service as any).fileDocument(tenancy, "INVENTORY", "Check-in-inventory.pdf", { url: "https://files.example/inventory.pdf", key: null, uploaderRole: Role.LANDLORD_AGENCY }, true);

		expect(tenancies.appendDocument).toHaveBeenCalledTimes(2);
	});

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

	it("Gmail, landlord's mailbox: a forged From of their team without a DMARC pass files as Other", async () => {
		const { service, me, email, tenancies } = setup({}, Role.LANDLORD_AGENCY, "agent@example.com", EmailProvider.GMAIL);
		await service.fileAttachment(me, email._id.toString(), 0);
		expect(tenancies.appendDocument).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: "OTHER" }));
	});

	it("Gmail, landlord's mailbox: their team's mail with a DMARC pass keeps the contract type", async () => {
		const { service, me, email, tenancies, getFull } = setup({}, Role.LANDLORD_AGENCY, "agent@example.com", EmailProvider.GMAIL);
		getFull.mockResolvedValue({ ...(await getFull()), senderAuthenticated: true });
		await service.fileAttachment(me, email._id.toString(), 0);
		expect(tenancies.appendDocument).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: "TENANCY_AGREEMENT" }));
	});

	it("Gmail, tenant's mailbox: an authenticated landlord contract keeps its contract type", async () => {
		const { service, me, email, tenancies, getFull } = setup({}, Role.STUDENT, "landlord@example.com", EmailProvider.GMAIL);
		getFull.mockResolvedValue({ ...(await getFull()), senderAuthenticated: true });
		await service.fileAttachment(me, email._id.toString(), 0);
		expect(tenancies.appendDocument).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: "TENANCY_AGREEMENT", confirmedByLandlord: false }));
	});

	it("Gmail, tenant's mailbox: a SENT label never authenticates a contract", async () => {
		const { service, me, email, tenancies, getFull } = setup({}, Role.STUDENT, "landlord@example.com", EmailProvider.GMAIL);
		getFull.mockResolvedValue({ ...(await getFull()), sent: true, senderAuthenticated: false });
		await service.fileAttachment(me, email._id.toString(), 0);
		expect(tenancies.appendDocument).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: "OTHER" }));
	});

	it("Gmail, tenant's mailbox: checks the provider's authenticated From, not the stored sender", async () => {
		const { service, me, email, tenancies, getFull } = setup({}, Role.STUDENT, "landlord@example.com", EmailProvider.GMAIL);
		getFull.mockResolvedValue({ ...(await getFull()), from: "attacker@example.com", senderAuthenticated: true });
		await service.fileAttachment(me, email._id.toString(), 0);
		expect(tenancies.appendDocument).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: "OTHER" }));
	});

	it("Gmail: the landlord's own sent mail (SENT label) keeps the contract type without any authentication header", async () => {
		const { service, me, email, tenancies, getFull } = setup({}, Role.LANDLORD_AGENCY, "landlord@example.com", EmailProvider.GMAIL);
		Object.assign(email, { outgoing: true, to: ["tenant@example.com"] });
		getFull.mockResolvedValue({ ...(await getFull()), sent: true });
		await service.fileAttachment(me, email._id.toString(), 0);
		expect(tenancies.appendDocument).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: "TENANCY_AGREEMENT", confirmedByLandlord: true }));
	});

	it("Gmail: an incoming mail forging the mailbox's own address as From files as Other, even if stored as outgoing", async () => {
		const { service, me, email, tenancies } = setup({}, Role.LANDLORD_AGENCY, "landlord@example.com", EmailProvider.GMAIL);
		Object.assign(email, { outgoing: true });
		await service.fileAttachment(me, email._id.toString(), 0);
		expect(tenancies.appendDocument).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: "OTHER" }));
	});

	it("files a tenant's own agreement sent to a deposit scheme as Other", async () => {
		const { service, me, email, tenancies } = setup();
		Object.assign(email, { outgoing: true, to: ["disputes@depositprotection.com"] });
		await service.fileAttachment(me, email._id.toString(), 0);
		expect(tenancies.appendDocument).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: "OTHER" }));
	});

	it("files inventory from a tenant mailbox as Other, never as the official inventory", async () => {
		const { service, me, email, tenancies } = setup({ name: "Check-in-inventory.pdf" });
		await service.fileAttachment(me, email._id.toString(), 0);
		expect(tenancies.appendDocument).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ type: "OTHER", uploadedBy: me._id, uploaderRole: Role.STUDENT })
		);
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

describe("ConnectorsService.storeFile", () => {
	it("takes an application/octet-stream PDF by its name, but only when the bytes are a PDF", async () => {
		const uploads = { putPrivateObject: jest.fn().mockResolvedValue({ url: "https://files.example/x.pdf", key: "k" }) };
		const service = new ConnectorsService(
			{ get: () => "test" } as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, uploads as any, {} as any,
			{} as any
		);
		const store = (name: string, mimeType: string, bytes: string) => (service as any).storeFile(
			{ provider: EmailProvider.GMAIL },
			{ _id: new Types.ObjectId() },
			{ name, mimeType, size: bytes.length, load: async () => Buffer.from(bytes) }
		);

		await expect(store("Lease.PDF", "application/octet-stream", "%PDF-1.7")).resolves.toMatchObject({ key: "k" });
		expect(uploads.putPrivateObject.mock.calls[0].slice(2)).toEqual(["application/pdf", "pdf"]);
		await expect(store("photo.jpeg", "application/octet-stream", "jpegbytes")).resolves.toMatchObject({ key: "k" });
		expect(uploads.putPrivateObject.mock.calls[1].slice(2)).toEqual(["image/jpeg", "jpg"]);

		uploads.putPrivateObject.mockClear();
		await expect(store("Lease.pdf", "application/octet-stream", "<html>")).resolves.toBeNull();
		await expect(store("notes.txt", "application/octet-stream", "%PDF")).resolves.toBeNull();
		expect(uploads.putPrivateObject).not.toHaveBeenCalled();
	});
});
