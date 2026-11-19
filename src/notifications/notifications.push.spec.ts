import { validate } from "class-validator";
import { Types } from "mongoose";
import { NotificationsService } from "./notifications.service";
import { NotificationKind } from "./notification-kind.enum";
import { PushTokenDto } from "./dto/push-token.dto";

const userId = new Types.ObjectId();
const flush = () => new Promise(resolve => setImmediate(resolve));

describe("push notifications", () => {
	const realFetch = global.fetch;
	let user: { notificationPrefs?: Record<string, boolean>; pushTokens?: string[] };
	let userModel: { findById: jest.Mock; updateOne: jest.Mock; updateMany: jest.Mock };
	let notificationModel: { create: jest.Mock; updateOne: jest.Mock };
	let service: NotificationsService;
	let fetchMock: jest.Mock;

	beforeEach(() => {
		user = { pushTokens: ["ExponentPushToken[a]"] };
		userModel = {
			findById: jest.fn(() => ({ lean: () => ({ exec: async () => user }) })),
			updateOne: jest.fn(async () => ({})),
			updateMany: jest.fn(async () => ({}))
		};
		notificationModel = {
			create: jest.fn(async () => ({ _id: new Types.ObjectId("65f000000000000000000001") })),
			updateOne: jest.fn(async () => ({ upsertedCount: 0 }))
		};
		service = new NotificationsService(notificationModel as never, userModel as never);
		fetchMock = jest.fn(async () => ({ json: async () => ({ data: [{ status: "ok" }] }) }));
		global.fetch = fetchMock as never;
	});
	afterEach(() => {
		global.fetch = realFetch;
	});

	const input = { user: userId, kind: NotificationKind.RENT_RECEIPT, title: "Paid", body: "Rent received", link: "/rent" };

	it("validates token format", async () => {
		const check = async (token: string) => (await validate(Object.assign(new PushTokenDto(), { token }))).length;
		expect(await check("ExponentPushToken[abc]")).toBe(0);
		expect(await check("ExpoPushToken[abc]")).toBe(0);
		expect(await check("abc")).toBe(1);
		expect(await check("ExponentPushToken[]")).toBe(1);
	});

	it("registers and removes a token", async () => {
		await service.addPushToken("u1", "ExponentPushToken[b]");
		// moved from another account: pulled from every other user first
		expect(userModel.updateMany).toHaveBeenCalledWith(
			{ _id: { $ne: "u1" }, pushTokens: "ExponentPushToken[b]" },
			{ $pull: { pushTokens: "ExponentPushToken[b]" } }
		);
		const pipeline = JSON.stringify(userModel.updateOne.mock.calls[0][1]);
		expect(pipeline).toContain("$filter"); // dedupe
		expect(pipeline).toContain("-10"); // cap
		expect(userModel.updateOne.mock.calls[0][0]).toEqual({ _id: "u1" });
		expect(JSON.stringify(userModel.updateOne.mock.calls[0][1])).toContain("ExponentPushToken[b]");
		await service.removePushToken("u1", "ExponentPushToken[b]");
		expect(userModel.updateOne.mock.calls[1][1]).toEqual({ $pull: { pushTokens: "ExponentPushToken[b]" } });
	});

	it("sends one push with the notification text", async () => {
		await service.notify(input);
		await flush();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://exp.host/--/api/v2/push/send");
		expect(JSON.parse(init.body)).toEqual([
			{
				to: "ExponentPushToken[a]",
				title: "Paid",
				body: "Rent received",
				data: { notificationId: "65f000000000000000000001", link: "/rent" },
				sound: "default"
			}
		]);
	});

	it("sends no push when the preference is off", async () => {
		user.notificationPrefs = { receiptEveryPayment: false };
		await service.notify(input, "receiptEveryPayment");
		await flush();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("removes DeviceNotRegistered tokens", async () => {
		fetchMock.mockResolvedValue({
			json: async () => ({ data: [{ status: "error", details: { error: "DeviceNotRegistered" } }] })
		});
		await service.notify(input);
		await flush();
		expect(userModel.updateOne).toHaveBeenCalledWith(
			{ _id: userId },
			{ $pull: { pushTokens: { $in: ["ExponentPushToken[a]"] } } }
		);
	});

	it("does not throw when fetch fails", async () => {
		fetchMock.mockRejectedValue(new Error("network"));
		const warn = jest.spyOn((service as never as { logger: { warn: () => void } }).logger, "warn").mockImplementation();
		await expect(service.notify(input)).resolves.toBe(true);
		await flush();
		expect(warn).toHaveBeenCalled();
	});

	it("sends no push when the dedupe path creates nothing", async () => {
		await service.notify({ ...input, dedupeKey: "k" });
		await flush();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
