import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
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
	const service = new ConnectorsService(config as any, connectionModel as any, messageModel as any, none, none, none, none, none, none, none, none);
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
		expect(deleteOne).toHaveBeenCalledWith({ _id: createdId });
	});
});
