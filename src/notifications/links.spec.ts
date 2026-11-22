import { NOTIFICATION_ROUTES, NotificationTargetKind, notificationTarget } from "./links";

/** Routes the clients actually declare (seek-web router, seek-mobile app/ folder). */
const WEB_ROUTES = ["/student/home", "/student/home/rent", "/student/home/deposit", "/rent", "/dashboard", "/repairs", "/contracts", "/applicants", "/application", "/student/inbox", "/chat"];
const MOBILE_ROUTES = ["/(app)/(tabs)/rent", "/(app)/deposit", "/(app)/(tabs)/my-home", "/(app)/contract", "/(app)/repairs", "/(app)/(tabs)/applied", "/(app)/chat/[id]"];

describe("notification links", () => {
	it("every kind maps to a real web and mobile route", () => {
		for (const kind of Object.values(NotificationTargetKind)) {
			for (const audience of ["student", "landlord"] as const) {
				const { link, target } = notificationTarget(audience, kind, "665f1c2e8f1b2a0012345678");
				expect(WEB_ROUTES).toContain(link.split("?")[0]);
				expect(target.screen).toBe(NOTIFICATION_ROUTES[kind][audience].screen);
				if (audience === "student") expect(MOBILE_ROUTES).toContain(target.mobile?.replace(/\/[0-9a-f]{24}$/, "/[id]"));
				else expect(target.mobile).toBeUndefined();
			}
		}
	});

	it("opens one application for a landlord when the listing is known", () => {
		expect(notificationTarget("landlord", NotificationTargetKind.APPLICATION, "a1", { listing: "l1" })).toEqual({
			link: "/application?listing=l1&id=a1",
			target: { kind: "APPLICATION", screen: "application", id: "a1", listing: "l1" }
		});
		expect(notificationTarget("landlord", NotificationTargetKind.APPLICATION, "a1").link).toBe("/applicants");
	});

	it("opens one conversation: landlord web chat, student mobile chat", () => {
		expect(notificationTarget("landlord", NotificationTargetKind.CONVERSATION, "c1")).toEqual({
			link: "/chat?conversation=c1",
			target: { kind: "CONVERSATION", screen: "conversation", id: "c1" }
		});
		expect(notificationTarget("student", NotificationTargetKind.CONVERSATION, "c1")).toEqual({
			link: "/student/inbox",
			target: { kind: "CONVERSATION", screen: "conversation", id: "c1", mobile: "/(app)/chat/c1" }
		});
	});

	it("opens a student's deposit on its tenancy", () => {
		expect(notificationTarget("student", NotificationTargetKind.COMPLIANCE, "t 1")).toMatchObject({
			link: "/student/home/deposit?tenancy=t%201",
			target: { kind: "COMPLIANCE", screen: "deposit", id: "t 1" }
		});
		expect(notificationTarget("student", NotificationTargetKind.COMPLIANCE).link).toBe("/student/home/deposit");
		expect(notificationTarget("landlord", NotificationTargetKind.COMPLIANCE, "t1").link).toBe("/dashboard");
	});

	it("sends a landlord's repair notification to the Repairs page", () => {
		expect(notificationTarget("landlord", NotificationTargetKind.REPAIRS).link).toBe("/repairs");
	});
});
