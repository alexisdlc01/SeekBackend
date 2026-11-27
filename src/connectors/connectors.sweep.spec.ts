import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Types } from "mongoose";
import { ConnectorsService } from "./connectors.service";
import { ConnectionStatus, EmailProvider } from "./email-connection.schema";
import { ProviderError } from "./providers/mail-provider";

const lean = <T>(value: T) => ({ lean: () => ({ exec: () => Promise.resolve(value) }) });

function setup(connections: Record<string, unknown>[], aggregate: unknown[] = []) {
	const values: Record<string, string> = { NODE_ENV: "test", JWT_ACCESS_TOKEN_SECRET: "test-jwt-secret" };
	const config = { get: (key: string) => values[key], getOrThrow: (key: string) => values[key] };
	const connectionModel = {
		find: jest.fn(() => lean(connections)),
		findOne: jest.fn((q: { _id: unknown }) => lean(connections.find(c => String(c._id) === String(q._id) && c.status !== ConnectionStatus.DISCONNECTED) ?? null)),
		updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 }),
		findById: jest.fn((id: string) => lean(connections.find(c => String(c._id) === String(id)) ?? null))
	};
	const messageModel = { aggregate: jest.fn().mockResolvedValue(aggregate) };
	const none = {} as any;
	const service = new ConnectorsService(config as any, connectionModel as any, messageModel as any, none, none, none, none, none, none, none, none, none);
	return { service, connectionModel, messageModel };
}

const owner = new Types.ObjectId();
const conn = (provider: EmailProvider, status = ConnectionStatus.CONNECTED) => ({
	_id: new Types.ObjectId(),
	user: owner,
	provider,
	status,
	emailAddress: "maya@example.com"
});

describe("ConnectorsService background sync", () => {
	it("syncs each connected mailbox in turn, skips unconfigured providers, and survives a failure", async () => {
		const failing = conn(EmailProvider.DEMO);
		const gmail = conn(EmailProvider.GMAIL); // no GMAIL_CLIENT_ID on this server
		const ok = conn(EmailProvider.DEMO);
		const { service, connectionModel } = setup([failing, gmail, ok]);
		const sync = jest.spyOn(service, "syncConnection").mockRejectedValueOnce(new Error("boom")).mockResolvedValue({} as any);
		expect(await service.syncAll()).toBe(1);
		expect(connectionModel.find).toHaveBeenCalledWith({
			$or: [{ status: ConnectionStatus.CONNECTED }, { status: ConnectionStatus.ERROR, retryAt: { $lte: expect.any(Date) } }]
		});
		expect(sync.mock.calls.map(call => call[0])).toEqual([failing, ok]);
	});

	it("skips a mailbox disconnected between the list and its turn", async () => {
		const first = conn(EmailProvider.DEMO);
		const gone = conn(EmailProvider.DEMO);
		const { service } = setup([first, gone]);
		const sync = jest.spyOn(service, "syncConnection").mockImplementation(async () => {
			gone.status = ConnectionStatus.DISCONNECTED; // user disconnects while the sweep runs
			return {} as any;
		});
		expect(await service.syncAll()).toBe(1);
		expect(sync).toHaveBeenCalledTimes(1);
	});
});

describe("ConnectorsService sync errors", () => {
	const failWith = async (error: Error) => {
		const gmail = { ...conn(EmailProvider.GMAIL), accessTokenEnc: "x" };
		const { service, connectionModel } = setup([gmail]);
		(service as any).userModel = { findById: () => ({ select: () => lean({ _id: owner, role: "STUDENT" }) }) };
		jest.spyOn(service, "contactBook").mockResolvedValue({ byEmail: new Map(), byUser: new Map() } as any);
		jest.spyOn(service as any, "accessToken").mockRejectedValue(error);
		await expect(service.syncConnection(gmail as any)).rejects.toBeDefined();
		return (connectionModel.updateOne.mock.calls[0] as any)[1].$set;
	};

	it("retries a transient failure an hour later, but waits for the user after a revoked token", async () => {
		const transient = await failWith(new ProviderError("Mail provider answered 503.", 503));
		expect(transient.status).toBe(ConnectionStatus.ERROR);
		expect(transient.retryAt.getTime()).toBeGreaterThan(Date.now() + 59 * 60_000);
		expect((await failWith(new ProviderError("Mail provider answered 400.", 400))).retryAt).toBeNull();
		expect((await failWith(new ServiceUnavailableException("Reconnect this mailbox."))).retryAt).toBeNull();
	});
});

describe("ConnectorsService IMAP replies and matches", () => {
	it("refuses an IMAP reply with a 400 before any send, even when the mailbox is in error", async () => {
		const imap = conn(EmailProvider.IMAP, ConnectionStatus.ERROR);
		const { service } = setup([imap]);
		await expect(service.sendReply({ _id: owner } as any, { connection: imap._id } as any, "Hi")).rejects.toBeInstanceOf(BadRequestException);
	});

	it("returns at most 50 matched contacts to the owner only, without message content", async () => {
		const gmail = conn(EmailProvider.GMAIL);
		const at = new Date("2026-11-01T10:00:00Z");
		const { service, messageModel } = setup([gmail], [{ _id: "james@lets.co.uk", name: "James", lastMessageAt: at }]);
		expect(await service.matches({ _id: owner } as any, gmail._id.toString())).toEqual([
			{ name: "James", email: "james@lets.co.uk", lastMessageAt: at }
		]);
		expect(messageModel.aggregate.mock.calls[0][0]).toContainEqual({ $limit: 50 });
		await expect(service.matches({ _id: new Types.ObjectId() } as any, gmail._id.toString())).rejects.toThrow("someone else");
	});
});

describe("ConnectorsService store during a disconnect", () => {
	it("deletes the email it just wrote when the mailbox was disconnected meanwhile", async () => {
		const gmail = conn(EmailProvider.GMAIL, ConnectionStatus.DISCONNECTED);
		const { service, messageModel } = setup([gmail]);
		const createdId = new Types.ObjectId();
		const deleteOne = jest.fn().mockResolvedValue({ deletedCount: 1 });
		Object.assign(messageModel, {
			create: jest.fn().mockResolvedValue({ _id: createdId, toObject: () => ({ attachments: [] }) }),
			deleteOne
		});
		(service as any).connectionModel.exists = jest.fn().mockResolvedValue(null);
		jest.spyOn(service as any, "tenancyFor").mockResolvedValue(null);
		const mail = { providerThreadId: "t", providerMessageId: "m", from: "a@b.co", to: ["maya@example.com"], subject: "s", body: "b", receivedAt: new Date(), attachments: [] };

		await expect((service as any).store(gmail, { _id: owner, role: "STUDENT" }, mail, { category: "OTHER" }, true)).resolves.toBe(0);
		expect(deleteOne).toHaveBeenCalledWith({ _id: createdId });
	});
});

describe("ConnectorsService store auto-filing", () => {
	it("files a council tax exemption certificate from the university as such, without the landlord-sender check", async () => {
		const gmail = conn(EmailProvider.GMAIL);
		const { service, messageModel } = setup([gmail]);
		Object.assign(messageModel, {
			create: jest.fn().mockResolvedValue({ _id: new Types.ObjectId(), toObject: () => ({ attachments: [{ name: "Council-tax-exemption.pdf" }] }) }),
			updateOne: jest.fn().mockResolvedValue({})
		});
		(service as any).connectionModel.exists = jest.fn().mockResolvedValue({ _id: gmail._id });
		const tenancy = { _id: new Types.ObjectId(), landlord: new Types.ObjectId() };
		jest.spyOn(service as any, "tenancyFor").mockResolvedValue({ tenancy, listing: null, label: "My home" });
		const trustedSender = jest.spyOn(service as any, "trustedSender").mockResolvedValue(false);
		jest.spyOn(service as any, "storeFile").mockResolvedValue({ url: "https://files.example/a.pdf", key: "k" });
		const fileDocument = jest.spyOn(service as any, "fileDocument").mockResolvedValue(undefined);
		const attachment = { name: "Council-tax-exemption.pdf", mimeType: "application/pdf", size: 10, load: async () => null };
		const mail = { providerThreadId: "t", providerMessageId: "m", from: "registry@st-andrews.ac.uk", to: ["maya@example.com"], subject: "Your council tax exemption certificate", body: "b", receivedAt: new Date(), attachments: [attachment] };

		await expect((service as any).store(gmail, { _id: owner, role: "STUDENT" }, mail, { category: "OTHER" }, false)).resolves.toBe(1);
		expect(fileDocument.mock.calls[0][1]).toBe("COUNCIL_TAX_EXEMPTION");
		expect(trustedSender).not.toHaveBeenCalled();
	});

	it("creates a shared bill only from a known provider domain, never from a keyword subject", async () => {
		const gmail = conn(EmailProvider.GMAIL);
		const { service, messageModel } = setup([gmail]);
		Object.assign(messageModel, {
			create: jest.fn().mockResolvedValue({ _id: new Types.ObjectId(), toObject: () => ({ attachments: [{ name: "bill.pdf" }] }) }),
			updateOne: jest.fn().mockResolvedValue({})
		});
		(service as any).connectionModel.exists = jest.fn().mockResolvedValue({ _id: gmail._id });
		jest.spyOn(service as any, "tenancyFor").mockResolvedValue({ tenancy: { _id: new Types.ObjectId() }, listing: null, label: "My home" });
		jest.spyOn(service as any, "askedReferenceType").mockReturnValue(null);
		jest.spyOn(service as any, "storeFile").mockResolvedValue({ url: "https://files.example/a.pdf", key: "k" });
		const fileBill = jest.spyOn(service as any, "fileBill").mockResolvedValue(true);
		const { classifyEmail } = await import("./housing-filter");
		const attachment = { name: "bill.pdf", mimeType: "application/pdf", size: 10, load: async () => null };
		const store = (from: string) => {
			const mail = { providerThreadId: "t", providerMessageId: from, from, to: ["maya@example.com"], subject: "Energy bill statement", body: "Total: £900.00", receivedAt: new Date(), attachments: [attachment] };
			return (service as any).store(gmail, { _id: owner, role: "STUDENT" }, mail, classifyEmail({ ...mail, outgoing: false }, new Map()), false);
		};

		expect(classifyEmail({ from: "landlord.scam@gmail.com", to: [], subject: "Energy bill statement", outgoing: false }, new Map())).toMatchObject({ category: "BILLS", reason: "Housing keywords" });
		await expect(store("landlord.scam@gmail.com")).resolves.toBe(0);
		expect(fileBill).not.toHaveBeenCalled();
		await expect(store("bills@octopus.energy")).resolves.toBe(1);
		expect(fileBill).toHaveBeenCalledTimes(1);
	});
});

describe("ConnectorsService reply during a disconnect", () => {
	it("deletes the sent copy when the mailbox was disconnected while sending", async () => {
		const demo = conn(EmailProvider.DEMO);
		const { service, messageModel } = setup([demo]);
		const createdId = new Types.ObjectId();
		const deleteOne = jest.fn().mockResolvedValue({ deletedCount: 1 });
		Object.assign(messageModel, { create: jest.fn().mockResolvedValue({ _id: createdId }), deleteOne });
		(service as any).connectionModel.exists = jest.fn().mockResolvedValue(null);
		const replyTo = { connection: demo._id, from: "landlord@x.co", to: [], subject: "Hi", providerThreadId: "t", providerMessageId: "m", threadKey: "k", counterpartEmail: "landlord@x.co", counterpartName: "L", outgoing: false } as any;

		await service.sendReply({ _id: owner, name: "Maya" } as any, replyTo, "Thanks");
		const stored = (messageModel as any).create.mock.calls[0][0];
		expect(stored.snippet).toMatch(/^v1:/);
		expect(service.decryptEmailBody(stored.snippet)).toBe("Thanks");
		expect(deleteOne).toHaveBeenCalledWith({ _id: createdId });
	});
});

describe("ConnectorsService disconnect", () => {
	it("clears lastSyncAt so a reconnect re-imports the history it deleted", async () => {
		const imap = { ...conn(EmailProvider.IMAP), lastSyncAt: new Date("2026-11-10T00:00:00Z") };
		const { service, connectionModel, messageModel } = setup([imap]);
		Object.assign(messageModel, { deleteMany: jest.fn().mockResolvedValue({ deletedCount: 40 }), distinct: jest.fn().mockResolvedValue([]) });

		await service.disconnect({ _id: owner } as any, imap._id.toString());
		expect((connectionModel.updateOne.mock.calls[0] as any)[1].$set).toMatchObject({
			status: ConnectionStatus.DISCONNECTED,
			lastSyncAt: null
		});
	});

	describe("erases the mailbox's attachment files", () => {
		const key = () => `private/${owner.toString()}/${randomUUID()}.pdf`;
		const run = (deletePrivateObject: jest.Mock) => {
			const imap = conn(EmailProvider.IMAP);
			const { connectionModel } = setup([imap]);
			const unused = key();
			const otherEmail = key();
			const filedToTenancy = key();
			const inPassport = key();
			const notOwned = `private/${new Types.ObjectId().toString()}/${randomUUID()}.pdf`;
			const messageModel = {
				deleteMany: jest.fn().mockResolvedValue({ deletedCount: 3 }),
				distinct: jest.fn()
					// The mailbox's own emails, read before they are deleted.
					.mockResolvedValueOnce([unused, otherEmail, filedToTenancy, inPassport, notOwned, "public/x.png"])
					// Emails left afterwards (another mailbox) that still point at a file.
					.mockResolvedValueOnce([otherEmail])
			};
			const tenancyModel = { distinct: jest.fn().mockResolvedValue([filedToTenancy]) };
			const userModel = { distinct: jest.fn().mockResolvedValue([inPassport]) };
			const contractModel = { distinct: jest.fn().mockResolvedValue([]) };
			const none = {} as any;
			const service = new ConnectorsService(
				{ get: () => "test" } as any, connectionModel as any, messageModel as any, tenancyModel as any, none,
				userModel as any, none, none, none, { deletePrivateObject } as any, none, contractModel as any
			);
			return { service, imap, unused, notOwned, messageModel };
		};

		it("deletes an attachment nothing else uses and keeps one still referenced", async () => {
			const deletePrivateObject = jest.fn().mockResolvedValue(undefined);
			const { service, imap, unused, messageModel } = run(deletePrivateObject);

			await expect(service.disconnect({ _id: owner } as any, imap._id.toString())).resolves.toMatchObject({ removedEmails: 3 });
			expect(messageModel.distinct.mock.calls[0][1]).toMatchObject({ connection: imap._id });
			// Only the unused file, and only after its emails were deleted; never another user's file or a public one.
			expect(deletePrivateObject.mock.calls).toEqual([[unused]]);
			expect(messageModel.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(deletePrivateObject.mock.invocationCallOrder[0]);
		});

		it("still disconnects when S3 refuses the delete", async () => {
			const s3Error = Object.assign(new Error("Service Unavailable"), { name: "ServiceUnavailable", $metadata: { httpStatusCode: 503 } });
			const deletePrivateObject = jest.fn().mockRejectedValue(s3Error);
			const { service, imap } = run(deletePrivateObject);

			await expect(service.disconnect({ _id: owner } as any, imap._id.toString())).resolves.toMatchObject({
				status: ConnectionStatus.DISCONNECTED,
				removedEmails: 3
			});
			expect(deletePrivateObject).toHaveBeenCalledTimes(1);
		});
	});
});

describe("ConnectorsService store files a referee's reply", () => {
	const student = {
		_id: owner,
		role: "STUDENT",
		referenceRequests: [{ type: "LANDLORD_REFERENCE", name: "Jo", email: "jo@oldlets.co.uk", requestedAt: new Date() }]
	};
	const reply = (from: string, senderAuthenticated: boolean, name = "maya.pdf") => ({
		providerThreadId: "t",
		providerMessageId: "m",
		from,
		to: ["maya@example.com"],
		subject: "Re: Landlord reference for Maya",
		body: "Attached.",
		receivedAt: new Date(),
		senderAuthenticated,
		attachments: [{ name, mimeType: "application/pdf", size: 10, load: async () => null }]
	});
	const run = async (from: string, authenticated: boolean, added = true, name = "maya.pdf", asked = student) => {
		const gmail = conn(EmailProvider.GMAIL);
		const { service, messageModel } = setup([gmail]);
		Object.assign(messageModel, {
			create: jest.fn().mockResolvedValue({ _id: new Types.ObjectId(), toObject: () => ({ attachments: [{ name: "maya.pdf" }] }) }),
			updateOne: jest.fn().mockResolvedValue({})
		});
		(service as any).connectionModel.exists = jest.fn().mockResolvedValue({ _id: gmail._id });
		jest.spyOn(service as any, "tenancyFor").mockResolvedValue(null);
		jest.spyOn(service as any, "storeFile").mockResolvedValue({ url: "https://files/x.pdf", key: "x.pdf" });
		const addReference = jest.spyOn(service as any, "addReference").mockResolvedValue(added);
		const filed = await (service as any).store(gmail, asked, reply(from, authenticated, name), { category: "OTHER", contact: null }, false);
		return { filed, addReference, messageModel };
	};

	it("does not count or label the reply as filed when the student already has a live reference of that type", async () => {
		const { filed, addReference, messageModel } = await run("jo@oldlets.co.uk", true, false);
		expect(addReference).toHaveBeenCalled();
		expect(filed).toBe(0);
		const saved = (messageModel as any).updateOne.mock.calls.at(-1)[1].$set.attachments[0];
		expect(saved.filedAs).toBeUndefined();
	});

	it("replaces only an expired or rejected reference, atomically, and says whether it added one", async () => {
		const userModel = { findOneAndUpdate: jest.fn().mockResolvedValue(null), updateOne: jest.fn().mockResolvedValueOnce({ modifiedCount: 0 }) };
		const service = new ConnectorsService({ get: () => undefined } as any, {} as any, {} as any, {} as any, {} as any, userModel as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
		const add = () => (service as any).addReference(student, "LANDLORD_REFERENCE", "maya.pdf", { url: "https://files/x.pdf", key: null });

		expect(await add()).toBe(false);
		const [[pullFilter, pull]] = userModel.findOneAndUpdate.mock.calls;
		const [[pushFilter, push]] = userModel.updateOne.mock.calls;
		expect(pull).toEqual({ $pull: { documents: { type: "LANDLORD_REFERENCE" } } });
		// Provided straight away, like any upload: nothing at Seek verifies it later.
		expect(push.$push.documents).toMatchObject({ type: "LANDLORD_REFERENCE", status: "PROVIDED" });
		// Both steps share one "no live document of this type" guard, so a valid reference is never removed or doubled.
		expect(pushFilter).toBe(pullFilter);
		const live = pullFilter.$nor[0].documents.$elemMatch;
		expect(live).toMatchObject({ type: "LANDLORD_REFERENCE", status: { $nin: ["REJECTED", "EXPIRED"] } });
		const cutoff = live.$or[1].expiresAt.$gt.getTime();
		expect(Math.abs(cutoff - (Date.now() - 24 * 3_600_000))).toBeLessThan(5_000);

		userModel.updateOne.mockResolvedValueOnce({ modifiedCount: 1 });
		expect(await add()).toBe(true);
	});

	it("erases the file of the expired reference it replaced, through the account's usual check", async () => {
		const oldKey = "private/aaaaaaaaaaaaaaaaaaaaaaaa/123e4567-e89b-12d3-a456-426614174000.pdf";
		const userModel = {
			findOneAndUpdate: jest.fn().mockResolvedValue({ documents: [{ type: "IDENTIFICATION", key: "other" }, { type: "LANDLORD_REFERENCE", key: oldKey }] }),
			updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 })
		};
		const eraseReplacedDocument = jest.fn().mockResolvedValue(undefined);
		const moduleRef = { get: jest.fn().mockReturnValue({ eraseReplacedDocument }) };
		const service = new ConnectorsService({ get: () => undefined } as any, {} as any, {} as any, {} as any, {} as any, userModel as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, moduleRef as any);

		expect(await (service as any).addReference(student, "LANDLORD_REFERENCE", "maya.pdf", { url: "https://files/x.pdf", key: "new" })).toBe(true);
		expect(eraseReplacedDocument).toHaveBeenCalledWith(student._id, oldKey);
	});

	it("files the PDF under the requested type when the asked referee's authenticated address sent it", async () => {
		const { filed, addReference } = await run("Jo@OldLets.co.uk", true);
		expect(filed).toBe(1);
		expect(addReference).toHaveBeenCalledWith(student, "LANDLORD_REFERENCE", "maya.pdf", { url: "https://files/x.pdf", key: "x.pdf" });
	});

	it("files a tenancy-document-looking name as the reference when the asked guarantor sent it", async () => {
		const guarantor = { ...student, referenceRequests: [{ type: "GUARANTOR_AGREEMENT", name: "Aisha", email: "aisha@example.com", requestedAt: new Date() }] };
		const { filed, addReference } = await run("aisha@example.com", true, true, "AST Guarantor Agreement.pdf", guarantor);
		expect(filed).toBe(1);
		expect(addReference).toHaveBeenCalledWith(guarantor, "GUARANTOR_AGREEMENT", "AST Guarantor Agreement.pdf", { url: "https://files/x.pdf", key: "x.pdf" });
	});

	it("ignores the same address when SPF/DKIM did not pass", async () => {
		const { filed, addReference } = await run("jo@oldlets.co.uk", false);
		expect(filed).toBe(0);
		expect(addReference).not.toHaveBeenCalled();
	});

	it("ignores an authenticated sender the student never asked", async () => {
		const { filed, addReference } = await run("someone@else.co.uk", true);
		expect(filed).toBe(0);
		expect(addReference).not.toHaveBeenCalled();
	});
});

describe("ConnectorsService store threads IMAP replies", () => {
	// The landlord thread holds one stored message, <root@landlord> from landlord@x.co.
	const run = async (from: string) => {
		const imap = conn(EmailProvider.IMAP);
		const { service, messageModel } = setup([imap]);
		const stored = [{ connection: imap._id, providerThreadId: "imap-1", internetMessageId: "<root@landlord>", from: "landlord@x.co", to: ["maya@example.com"] }];
		Object.assign(messageModel, {
			distinct: jest.fn(async (_field: string, q: { internetMessageId: { $in: string[] } }) =>
				stored.filter(m => q.internetMessageId.$in.includes(m.internetMessageId)).map(m => m.providerThreadId)
			),
			findOne: jest.fn((q: { providerThreadId: { $in: string[] }; $or: [{ from: string }, { to: string }] }) => {
				const hit = stored.find(m => q.providerThreadId.$in.includes(m.providerThreadId) && (m.from === q.$or[0].from || m.to.includes(q.$or[1].to)));
				return { select: () => lean(hit ?? null) };
			}),
			create: jest.fn().mockResolvedValue({ _id: new Types.ObjectId(), toObject: () => ({ attachments: [] }) }),
			updateOne: jest.fn().mockResolvedValue({})
		});
		(service as any).connectionModel.exists = jest.fn().mockResolvedValue({ _id: imap._id });
		jest.spyOn(service as any, "tenancyFor").mockResolvedValue(null);
		const mail = {
			providerThreadId: "imap-9",
			providerMessageId: "9",
			internetMessageId: "<new@x>",
			references: ["<root@landlord>"],
			from,
			to: ["maya@example.com"],
			subject: "Re: rent",
			snippet: "",
			body: "",
			receivedAt: new Date(),
			attachments: []
		};
		await (service as any).store(imap, { _id: owner, role: "STUDENT" }, mail, { category: "OTHER", contact: null }, false);
		return (messageModel as any).create.mock.calls[0][0].providerThreadId;
	};

	it("keeps a stranger citing the landlord thread in References out of it", async () => {
		expect(await run("stranger@evil.co")).toBe("imap-9");
	});

	it("lets the landlord's own reply join the thread", async () => {
		expect(await run("landlord@x.co")).toBe("imap-1");
	});
});
