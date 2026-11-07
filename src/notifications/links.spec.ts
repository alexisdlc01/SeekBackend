import { NOTIFICATION_ROUTES, NotificationTargetKind, notificationTarget } from "./links";

/** Routes the clients actually declare (seek-web router, seek-mobile app/ folder). */
const WEB_ROUTES = ["/student/home", "/student/home/rent", "/student/home/deposit", "/rent", "/dashboard", "/contracts", "/applicants", "/application"];
const MOBILE_ROUTES = ["/(app)/(tabs)/rent", "/(app)/deposit", "/(app)/(tabs)/my-home", "/(app)/contract", "/(app)/repairs", "/(app)/(tabs)/applied"];

describe("notification links", () => {
	it("every kind maps to a real web and mobile route", () => {
		for (const kind of Object.values(NotificationTargetKind)) {
			for (const audience of ["student", "landlord"] as const) {
				const { link, target } = notificationTarget(audience, kind, "665f1c2e8f1b2a0012345678");
				expect(WEB_ROUTES).toContain(link.split("?")[0]);
				expect(target.screen).toBe(NOTIFICATION_ROUTES[kind][audience].screen);
				if (audience === "student") expect(MOBILE_ROUTES).toContain(target.mobile);
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
});
