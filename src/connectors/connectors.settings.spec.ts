import { BadRequestException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Types } from "mongoose";
import { ConnectorsService } from "./connectors.service";
import { EmailProvider } from "./email-connection.schema";
import { decodeHeader, isPrivateAddress, parseFetchHeaders } from "./providers/imap.client";
import * as imap from "./providers/imap.client";
import { decryptToken, deriveDevelopmentKey } from "./token-crypto";

const lean = <T>(value: T) => ({ lean: () => ({ exec: () => Promise.resolve(value) }) });
const selectLean = <T>(value: T) => ({ select: () => lean(value) });
const SECRET = "test-jwt-secret";

function setup(env: Record<string, string> = {}, connectorSettings?: Record<string, boolean>) {
	const userId = new Types.ObjectId();
	const values: Record<string, string> = { NODE_ENV: "test", JWT_ACCESS_TOKEN_SECRET: SECRET, ...env };
	const config = {
		get: (key: string) => values[key],
		getOrThrow: (key: string) => values[key]
	};
	const connectionModel = {
		updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 }),
		updateMany: jest.fn().mockResolvedValue({}),
		exists: jest.fn().mockResolvedValue({ _id: "c" }),
		findOneAndUpdate: jest.fn((_q, update) => lean({ _id: new Types.ObjectId(), user: userId, ...update.$set }))
	};
	const messageModel = { exists: jest.fn().mockResolvedValue(null), deleteMany: jest.fn().mockResolvedValue({}) };
	const userModel = {
		findById: jest.fn(() => selectLean({ _id: userId, name: "Maya", email: "maya@example.com", connectorSettings })),
		updateOne: jest.fn().mockResolvedValue({}),
		exists: jest.fn().mockResolvedValue(null)
	};
	const store = new Map<string, string>();
	const redis = {
		set: jest.fn((key: string, value: string) => Promise.resolve(store.set(key, value) && "OK")),
		get: jest.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
		del: jest.fn((key: string) => Promise.resolve(store.delete(key) ? 1 : 0))
	};
	const service = new ConnectorsService(
		config as any,
		connectionModel as any,
		messageModel as any,
		{} as any,
		{} as any,
		userModel as any,
		{} as any,
		{} as any,
		{} as any,
		{} as any,
		redis as any
	);
	return { service, userId, connectionModel, userModel, messageModel };
}

const mail = (id: string, from: string, subject: string) => ({
	providerMessageId: id,
	providerThreadId: id,
	internetMessageId: null,
	from,
	fromName: "",
	to: ["maya@example.com"],
	subject,
	snippet: "",
	receivedAt: new Date("2026-11-01T10:00:00Z"),
	body: "",
	attachments: []
});

describe("ConnectorsService callback provider names", () => {
	it("accepts any casing and keeps gmail/outlook canonical", () => {
		const { service } = setup();
		expect(service.parseOAuthProvider("gmail")).toBe(EmailProvider.GMAIL);
		expect(service.parseOAuthProvider("GMAIL")).toBe(EmailProvider.GMAIL);
		expect(service.parseOAuthProvider(" Outlook ")).toBe(EmailProvider.OUTLOOK);
		expect(() => service.parseOAuthProvider("imap")).toThrow(BadRequestException);
	});

	it("redirects a mixed-case callback with the lowercase connector name", async () => {
		const { service } = setup();
		const target = await service.handleCallback("Gmail", { state: "not-a-jwt", code: "x" });
		expect(target).toBe("http://localhost:5173/connectors?connector=gmail&status=error&reason=invalid_state");
	});
});

describe("ConnectorsService OAuth callback binds the mailbox to who consented", () => {
	const jwt = new JwtService({ secret: SECRET });
	const env = { GMAIL_CLIENT_ID: "id", GMAIL_CLIENT_SECRET: "secret" };
	const stateFor = (url: string) => new URL(url).searchParams.get("state")!;

	function oauthSetup() {
		const ctx = setup(env);
		const gmail = (ctx.service as any).clients[EmailProvider.GMAIL];
		jest.spyOn(gmail, "exchangeCode").mockResolvedValue({ accessToken: "at", refreshToken: "rt", expiresAt: null });
		jest.spyOn(gmail, "mailboxAddress").mockResolvedValue("victim@gmail.com");
		jest.spyOn(ctx.service as any, "syncConnection").mockResolvedValue({});
		jest.spyOn(ctx.service as any, "view").mockResolvedValue({ id: "c1" });
		return ctx;
	}
	afterEach(() => jest.restoreAllMocks());

	it("web: state of user A + cookie of user B -> invalid_state, no connection", async () => {
		const { service, userId, connectionModel } = oauthSetup();
		const { url } = await service.authUrl({ _id: userId }, "gmail");
		const cookieB = jwt.sign({ userId: new Types.ObjectId().toString(), sessionId: "s" });
		const target = await service.handleCallback("gmail", { code: "c", state: stateFor(url) }, cookieB);
		expect(target).toBe("http://localhost:5173/connectors?connector=gmail&status=error&reason=invalid_state");
		const noCookie = await service.handleCallback("gmail", { code: "c", state: stateFor(url) });
		expect(noCookie).toContain("reason=invalid_state");
		expect(connectionModel.findOneAndUpdate).not.toHaveBeenCalled();
	});

	it("web: the requester's own cookie connects the mailbox to them", async () => {
		const { service, userId, connectionModel } = oauthSetup();
		const { url } = await service.authUrl({ _id: userId }, "gmail");
		const cookieA = jwt.sign({ userId: userId.toString(), sessionId: "s" });
		const target = await service.handleCallback("gmail", { code: "c", state: stateFor(url) }, cookieA);
		expect(target).toContain("status=connected");
		expect(connectionModel.findOneAndUpdate.mock.calls[0][0].user.toString()).toBe(userId.toString());
	});

	it("mobile: nothing is connected until the link's owner confirms the nonce", async () => {
		const { service, userId, connectionModel } = oauthSetup();
		const { url } = await service.authUrl({ _id: userId }, "gmail", "mobile");
		const target = await service.handleCallback("gmail", { code: "c", state: stateFor(url) });
		expect(target).toMatch(/^seekapp:\/\/connectors\?connector=gmail&status=pending&nonce=[\w-]{43}$/);
		expect(connectionModel.findOneAndUpdate).not.toHaveBeenCalled();
		const nonce = new URL(target).searchParams.get("nonce")!;

		// Someone else signed in (the phished victim's app) cannot claim it, and the nonce is burnt.
		await expect(service.confirmPending({ _id: new Types.ObjectId() }, "gmail", nonce)).rejects.toThrow(BadRequestException);
		await expect(service.confirmPending({ _id: userId }, "gmail", nonce)).rejects.toThrow(BadRequestException);
		expect(connectionModel.findOneAndUpdate).not.toHaveBeenCalled();
	});

	it("outlook outside production: demo mailbox, no Microsoft consent, even with MS_* set", async () => {
		const { service, userId } = oauthSetup();
		const connectDemo = jest.spyOn(service, "connectDemo").mockResolvedValue({} as any);
		expect(service.providers().find(item => item.provider === EmailProvider.OUTLOOK)).toEqual({ provider: EmailProvider.OUTLOOK, label: "Outlook (demo)", available: true });
		const { url } = await service.authUrl({ _id: userId }, "outlook");
		expect(url).toBe("http://localhost:5173/connectors?connector=outlook&status=connected");
		expect(connectDemo).toHaveBeenCalledTimes(1);
		expect((await service.authUrl({ _id: userId }, "outlook", "mobile")).url).toBe("seekapp://connectors?connector=outlook&status=connected");
	});

	it("mobile: the owner of the link confirms once", async () => {
		const { service, userId, connectionModel } = oauthSetup();
		const { url } = await service.authUrl({ _id: userId }, "gmail", "mobile");
		const nonce = new URL(await service.handleCallback("gmail", { code: "c", state: stateFor(url) })).searchParams.get("nonce")!;
		await expect(service.confirmPending({ _id: userId }, "gmail", nonce)).resolves.toEqual({ id: "c1" });
		expect(connectionModel.findOneAndUpdate.mock.calls[0][0].user.toString()).toBe(userId.toString());
		await expect(service.confirmPending({ _id: userId }, "gmail", nonce)).rejects.toThrow(BadRequestException);
	});
});

describe("ConnectorsService settings", () => {
	afterEach(() => jest.restoreAllMocks());
	const allOn = {
		scope: "housing",
		autoFileAttachments: true,
		addReferencesToProfile: true,
		readUtilityBills: true,
		copySignedContracts: true,
		aiDraftReplies: true
	};

	it("defaults to housing only with every toggle on, even for a legacy 'all' record", async () => {
		const { service } = setup({}, { housingOnly: false });
		await expect(service.settings({ _id: new Types.ObjectId() } as any)).resolves.toEqual(allOn);
	});

	it("stores each toggle on the user and never touches the read scope", async () => {
		const { service, userModel, connectionModel, userId } = setup();
		await service.updateSettings({ _id: userId } as any, { autoFileAttachments: false, readUtilityBills: false, aiDraftReplies: false });
		expect(userModel.updateOne).toHaveBeenCalledWith(
			{ _id: userId },
			{
				$set: {
					"connectorSettings.autoFileAttachments": false,
					"connectorSettings.readUtilityBills": false,
					"connectorSettings.aiDraftReplies": false
				}
			}
		);
		expect(connectionModel.updateMany).not.toHaveBeenCalled();
	});

	it("never stores a non-housing email, even when a legacy record says scope 'all'", async () => {
		const housing = mail("1", "lettings@holloway-lets.co.uk", "Your tenancy agreement");
		const other = mail("2", "news@shop.example", "50% off trainers");
		jest.spyOn(imap, "listRecentImap").mockResolvedValue([housing, other]);

		for (const settings of [undefined, { housingOnly: false, autoFileAttachments: false }]) {
			const { service, userId } = setup({}, settings as any);
			jest.spyOn(service, "contactBook").mockResolvedValue({ byEmail: new Map(), byUser: new Map() });
			jest.spyOn(service as any, "imapCredentials").mockReturnValue({ host: "imap.example.com", port: 993, username: "u", password: "p" });
			const store = jest.spyOn(service as any, "store").mockResolvedValue(0);
			const connection = { _id: new Types.ObjectId(), user: userId, provider: EmailProvider.IMAP, emailAddress: "maya@example.com" };

			const result = await service.syncConnection(connection as any);
			expect(store).toHaveBeenCalledTimes(1);
			expect((store.mock.calls[0][2] as any).providerMessageId).toBe("1");
			expect(result).toMatchObject({ imported: 1, skipped: 1 });
			// Sixth argument: the toggles, read from the user's settings.
			expect((store.mock.calls[0][5] as any).autoFileAttachments).toBe(!settings);
		}
	});

	it("stops storing once the mailbox is disconnected mid-sync, then deletes what slipped in", async () => {
		jest.spyOn(imap, "listRecentImap").mockResolvedValue([mail("1", "lettings@holloway-lets.co.uk", "Your tenancy agreement"), mail("2", "lettings@holloway-lets.co.uk", "Rent reminder")]);
		const { service, userId, connectionModel, messageModel } = setup();
		jest.spyOn(service, "contactBook").mockResolvedValue({ byEmail: new Map(), byUser: new Map() });
		jest.spyOn(service as any, "imapCredentials").mockReturnValue({ host: "imap.example.com", port: 993, username: "u", password: "p" });
		const store = jest.spyOn(service as any, "store").mockImplementation(async () => {
			connectionModel.exists.mockResolvedValue(null); // the user clicks Disconnect during the first store()
			connectionModel.updateOne.mockResolvedValue({ matchedCount: 0 });
			return 0;
		});
		const connection = { _id: new Types.ObjectId(), user: userId, provider: EmailProvider.IMAP, emailAddress: "maya@example.com" };
		await service.syncConnection(connection as any);
		expect(store).toHaveBeenCalledTimes(1);
		expect(messageModel.deleteMany).toHaveBeenCalledWith({ connection: connection._id });
	});

	it("treats an unset NODE_ENV as production: no demo mailbox, no private IMAP hosts", async () => {
		const { service } = setup({ NODE_ENV: "" });
		await expect(service.connectDemo({ _id: new Types.ObjectId() } as any)).rejects.toThrow("not available");
		expect(service.providers().some(item => item.provider === EmailProvider.DEMO)).toBe(false);
	});

	describe("store() honours the toggles", () => {
		const landlordId = new Types.ObjectId();
		const tenancy = { _id: new Types.ObjectId(), landlord: landlordId, documents: [] };
		const classification = { housing: true, category: "BILLS", counterpartName: "", contact: null };
		const fromLandlord = { ...classification, contact: { role: "LANDLORD", userId: landlordId.toString(), tenancyId: null } };
		const withFile = (subject: string, name: string) => ({ ...mail("9", "hello@octopus.energy", subject), body: "Total: £214.00", attachments: [{ name, mimeType: "application/pdf", size: 10 }] });

		function storeSetup(toggles: Partial<Record<string, boolean>>, role = "STUDENT", from: any = classification) {
			const { service, userModel, connectionModel } = setup();
			const created = { _id: new Types.ObjectId(), toObject: () => ({ attachments: [{ name: "x" }] }) };
			(service as any).messageModel = { create: jest.fn().mockResolvedValue(created), updateOne: jest.fn().mockResolvedValue({}), deleteOne: jest.fn().mockResolvedValue({}) };
			jest.spyOn(service as any, "tenancyFor").mockResolvedValue({ tenancy, listing: null, label: "My home" });
			jest.spyOn(service as any, "storeFile").mockResolvedValue({ url: "https://files.example/x.pdf", key: null });
			const fileDocument = jest.spyOn(service as any, "fileDocument").mockResolvedValue(undefined);
			const fileBill = jest.spyOn(service as any, "fileBill").mockResolvedValue(true);
			const run = (mailFull: any) =>
				(service as any).store({ _id: new Types.ObjectId() }, { _id: new Types.ObjectId(), role }, mailFull, from, false, {
					...allOn,
					...toggles
				});
			return { run, fileDocument, fileBill, userModel, connectionModel };
		}

		it("files bills only when reading utility bills is on", async () => {
			const off = storeSetup({ readUtilityBills: false });
			await expect(off.run(withFile("Your October statement", "statement.pdf"))).resolves.toBe(0);
			expect(off.fileBill).not.toHaveBeenCalled();
			const on = storeSetup({});
			await expect(on.run(withFile("Your October statement", "statement.pdf"))).resolves.toBe(1);
			expect(on.fileBill).toHaveBeenCalledTimes(1);
		});

		it("never files a landlord's own bill as a tenant bill", async () => {
			const landlord = storeSetup({}, "LANDLORD_AGENCY");
			await landlord.run(withFile("Council tax bill for 12 Elm Road", "bill.pdf"));
			expect(landlord.fileBill).not.toHaveBeenCalled();
		});

		it("files signed contracts only when copying contracts is on", async () => {
			const off = storeSetup({ copySignedContracts: false });
			await off.run(withFile("Tenancy agreement", "Tenancy-agreement.pdf"));
			expect(off.fileDocument).not.toHaveBeenCalled();
			const on = storeSetup({}, "STUDENT", fromLandlord);
			await on.run(withFile("Tenancy agreement", "Tenancy-agreement.pdf"));
			expect(on.fileDocument).toHaveBeenCalledWith(tenancy, "TENANCY_AGREEMENT", "Tenancy-agreement.pdf", expect.anything());
		});

		it("files a contract or certificate from anyone but the landlord or their team as a plain document", async () => {
			const stranger = storeSetup({});
			await stranger.run(withFile("Your tenancy agreement", "Tenancy-agreement.pdf"));
			await stranger.run(withFile("Gas safety", "gas-safety.pdf"));
			expect(stranger.fileDocument.mock.calls.map(call => call[1])).toEqual(["OTHER", "OTHER"]);
			expect(stranger.userModel.exists.mock.calls[0][0]).toMatchObject({ _id: landlordId, $or: [{ email: "hello@octopus.energy" }, { "team.email": "hello@octopus.energy" }] });

			const team = storeSetup({});
			team.userModel.exists.mockResolvedValue({ _id: landlordId });
			await team.run(withFile("Your tenancy agreement", "Tenancy-agreement.pdf"));
			expect(team.fileDocument.mock.calls[0][1]).toBe("TENANCY_AGREEMENT");
		});

		it("files nothing once the mailbox was disconnected while the email was being saved", async () => {
			const gone = storeSetup({}, "STUDENT", fromLandlord);
			gone.connectionModel.exists.mockResolvedValue(null);
			await expect(gone.run(withFile("Tenancy agreement", "Tenancy-agreement.pdf"))).resolves.toBe(0);
			expect(gone.fileDocument).not.toHaveBeenCalled();
		});

		it("adds references to a student's profile only when that toggle is on", async () => {
			const off = storeSetup({ addReferencesToProfile: false });
			await off.run(withFile("Your landlord reference", "Landlord-reference.pdf"));
			expect(off.userModel.updateOne).not.toHaveBeenCalled();
			const on = storeSetup({}, "STUDENT", fromLandlord);
			await expect(on.run(withFile("Your landlord reference", "Landlord-reference.pdf"))).resolves.toBe(1);
			const [, update] = on.userModel.updateOne.mock.calls[0] as any;
			expect(update.$push.documents).toMatchObject({ type: "LANDLORD_REFERENCE", status: "PENDING" });
		});

		it("never adds a reference sent by a housemate or a stranger", async () => {
			const housemate = { ...classification, contact: { role: "HOUSEHOLD", userId: new Types.ObjectId().toString(), tenancyId: null } };
			for (const from of [classification, housemate]) {
				const other = storeSetup({}, "STUDENT", from);
				await other.run(withFile("Your landlord reference", "Landlord-reference.pdf"));
				expect(other.userModel.updateOne).not.toHaveBeenCalled();
			}
		});
	});
});

describe("ConnectorsService IMAP", () => {
	afterEach(() => jest.restoreAllMocks());
	const dto = { host: "imap.example.com", port: 993, username: "Maya@Example.com", appPassword: "app-pass" };

	it("stores the app password encrypted", async () => {
		const { service, connectionModel } = setup();
		jest.spyOn(imap, "verifyImapLogin").mockResolvedValue();
		jest.spyOn(service, "syncConnection").mockResolvedValue({ scanned: 0, imported: 0, skipped: 0, filed: 0 });
		jest.spyOn(service as any, "connectionView").mockResolvedValue({});

		const result = await service.connectImap({ _id: new Types.ObjectId() } as any, dto);
		expect(result.mode).toBe("imap");
		const update = connectionModel.findOneAndUpdate.mock.calls[0][1].$set;
		expect(connectionModel.findOneAndUpdate.mock.calls[0][0].emailAddress).toBe("maya@example.com");
		expect(update.accessTokenEnc).not.toContain("app-pass");
		expect(decryptToken(update.accessTokenEnc, deriveDevelopmentKey(SECRET))).toBe("app-pass");
	});

	it("falls back to the demo mailbox in development when sign-in fails", async () => {
		const { service } = setup();
		jest.spyOn(imap, "verifyImapLogin").mockRejectedValue(new Error("ECONNREFUSED"));
		jest.spyOn(service, "connectDemo").mockResolvedValue({ scanned: 3, imported: 3, skipped: 0, filed: 1, connection: {} } as any);

		const result = await service.connectImap({ _id: new Types.ObjectId() } as any, dto);
		expect(result.mode).toBe("demo");
		expect(result.imported).toBe(3);
	});

	it("refuses in production when sign-in fails", async () => {
		const { service } = setup({ NODE_ENV: "production", CONNECTOR_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64") });
		jest.spyOn(imap, "verifyImapLogin").mockRejectedValue(new Error("NO"));
		await expect(service.connectImap({ _id: new Types.ObjectId() } as any, dto)).rejects.toBeInstanceOf(BadRequestException);
	});

	it("parses FETCH header literals and encoded subjects", () => {
		const header = "From: =?UTF-8?B?SmFtZXMgSG9sbG93YXk=?= <james@holloway-lets.co.uk>\r\nSubject: Rent\r\n =?utf-8?Q?reminder_=E2=80=93_Nov?=\r\nMessage-ID: <a1@x>\r\n\r\n";
		const text = `* 1 FETCH (UID 42 INTERNALDATE "01-Nov-2026 10:00:00 +0000" BODY[HEADER.FIELDS (FROM TO SUBJECT DATE MESSAGE-ID)] {${Buffer.byteLength(header)}}\r\n${Buffer.from(header).toString("latin1")})\r\nS4 OK done\r\n`;
		const [parsed] = parseFetchHeaders(text);
		expect(parsed.providerMessageId).toBe("42");
		expect(parsed.from).toBe("james@holloway-lets.co.uk");
		expect(parsed.fromName).toBe("James Holloway");
		expect(parsed.subject).toBe("Rent reminder – Nov");
		expect(parsed.internetMessageId).toBe("<a1@x>");
		expect(decodeHeader("plain")).toBe("plain");
	});

	it("flags private addresses", () => {
		expect(isPrivateAddress("127.0.0.1")).toBe(true);
		expect(isPrivateAddress("10.2.3.4")).toBe(true);
		expect(isPrivateAddress("::1")).toBe(true);
		expect(isPrivateAddress("17.57.152.5")).toBe(false);
	});
});
