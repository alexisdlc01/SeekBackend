import { NotFoundException } from "@nestjs/common";
import { Types } from "mongoose";
import { NotificationsController } from "./notifications.controller";
import { NotificationsService, teamNotificationKinds } from "./notifications.service";
import { NotificationKind } from "./notification-kind.enum";
import { TeamScope } from "../users/types/team-scope";

const ownerId = new Types.ObjectId();
const memberId = new Types.ObjectId();

describe("team member notifications", () => {
	let rows: { _id: Types.ObjectId; user: Types.ObjectId; kind: NotificationKind; readAt: Date | null }[];
	let controller: NotificationsController;

	// Minimal in-memory stand-in for the two queries the bell uses.
	const matches = (row: (typeof rows)[number], filter: Record<string, unknown>) =>
		(!filter._id || row._id.toString() === String(filter._id)) &&
		row.user.equals(filter.user as Types.ObjectId) &&
		(!filter.kind || (filter.kind as { $in: NotificationKind[] }).$in.includes(row.kind));

	beforeEach(() => {
		const row = (user: Types.ObjectId, kind: NotificationKind) => ({ _id: new Types.ObjectId(), user, kind, readAt: null });
		rows = [
			row(ownerId, NotificationKind.NEW_MESSAGE),
			row(ownerId, NotificationKind.REPAIR_REPORTED),
			row(ownerId, NotificationKind.PAYMENT_RECEIVED),
			row(ownerId, NotificationKind.RENT_LATE),
			row(memberId, NotificationKind.NEW_MESSAGE)
		];
		const chain = <T>(value: () => T) => ({ sort: () => ({ limit: () => ({ lean: () => ({ exec: async () => value() }) }) }) });
		const notificationModel = {
			find: jest.fn((filter: Record<string, unknown>) => chain(() => rows.filter(r => matches(r, filter)))),
			findOneAndUpdate: jest.fn((filter: Record<string, unknown>) => ({
				lean: () => ({
					exec: async () => {
						const found = rows.find(r => matches(r, filter));
						if (found) found.readAt = new Date();
						return found ?? null;
					}
				})
			}))
		};
		controller = new NotificationsController(new NotificationsService(notificationModel as never, {} as never));
	});

	const member = (scopes: TeamScope[]) =>
		({ _id: memberId, teamOf: { ownerId: ownerId.toString(), ownerName: "Owner", scopes } }) as never;

	it("shows a member the owner's notifications for their scopes, never payment ones", async () => {
		const inbox = await controller.list(member([TeamScope.VIEWINGS_INBOX]));
		expect(inbox.map(n => n.kind)).toEqual([NotificationKind.NEW_MESSAGE]);
		expect(inbox[0].user).toBe(ownerId);

		const all = await controller.list(member(Object.values(TeamScope)));
		expect(all.map(n => n.kind).sort()).toEqual([NotificationKind.NEW_MESSAGE, NotificationKind.REPAIR_REPORTED].sort());
	});

	it("lets a member mark a covered notification read and refuses the others", async () => {
		const repair = rows[1];
		const payment = rows[2];
		await controller.markRead(repair._id.toString(), member([TeamScope.REPAIRS]));
		expect(repair.readAt).not.toBeNull();
		await expect(controller.markRead(payment._id.toString(), member(Object.values(TeamScope)))).rejects.toBeInstanceOf(NotFoundException);
		await expect(controller.markRead(rows[0]._id.toString(), member([TeamScope.REPAIRS]))).rejects.toBeInstanceOf(NotFoundException);
		expect(payment.readAt).toBeNull();
	});

	it("sends OFFER_ACCEPTED (a contracts link) to TENANCIES members only", () => {
		expect(teamNotificationKinds([TeamScope.APPLICATIONS])).not.toContain(NotificationKind.OFFER_ACCEPTED);
		expect(teamNotificationKinds([TeamScope.TENANCIES])).toContain(NotificationKind.OFFER_ACCEPTED);
	});

	it("leaves the owner's own bell unfiltered", async () => {
		const own = await controller.list({ _id: ownerId } as never);
		expect(own).toHaveLength(4);
	});
});
