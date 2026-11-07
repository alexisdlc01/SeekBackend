/**
 * One vocabulary for where a notification or activity item leads.
 *
 * Every emitter builds its `link` through `notificationTarget`, so the web
 * path and the typed target can never disagree. Each target names a logical
 * `screen` (plus the `id` it is about) that both clients map to a real route:
 * `link` is the seek-web path, `target.mobile` the seek-mobile (Expo Router)
 * path for students. See NOTIFICATION_ROUTES for the full table.
 */
export enum NotificationTargetKind {
	PAYMENTS = "PAYMENTS",
	COMPLIANCE = "COMPLIANCE",
	TENANCY = "TENANCY",
	CONTRACTS = "CONTRACTS",
	REPAIRS = "REPAIRS",
	APPLICATION = "APPLICATION"
}

/** Logical client screens a notification can open. */
export enum NotificationScreen {
	/** Student rent: web /student/home/rent, mobile /(app)/(tabs)/rent. */
	RENT = "rent",
	/** Student deposit: web /student/home/deposit, mobile /(app)/deposit. */
	DEPOSIT = "deposit",
	/** Student home: web /student/home, mobile /(app)/(tabs)/my-home. */
	HOME = "home",
	/** Student contract: web /student/home, mobile /(app)/contract. */
	CONTRACT = "contract",
	/** Student repairs: web /student/home, mobile /(app)/repairs. */
	REPAIRS = "repairs",
	/** Student applications: web /student/home, mobile /(app)/(tabs)/applied. */
	APPLICATIONS = "applications",
	/** Landlord rent: web /rent. */
	LANDLORD_RENT = "landlord-rent",
	/** Landlord dashboard (compliance, repairs): web /dashboard. */
	DASHBOARD = "dashboard",
	/** Landlord contracts and tenancies: web /contracts. */
	CONTRACTS = "contracts",
	/** One application: web /application?listing=<listing>&id=<id>, or /applicants without a listing. */
	APPLICATION = "application"
}

export type Audience = "student" | "landlord";

export interface NotificationTarget {
	kind: NotificationTargetKind;
	/** Logical screen; see NotificationScreen for the web and mobile routes. */
	screen?: NotificationScreen;
	/** Tenancy, application... the screen is about. Absent for list screens. */
	id?: string;
	/** Listing of an application, needed by the landlord web route. */
	listing?: string;
	/** seek-mobile (Expo Router) path; students only, landlords use the web. */
	mobile?: string;
}

interface Route {
	screen: NotificationScreen;
	web: string;
	mobile?: string;
}

/** Kind × audience → screen and routes. Documented in the Notification DTO. */
export const NOTIFICATION_ROUTES: Record<NotificationTargetKind, Record<Audience, Route>> = {
	[NotificationTargetKind.PAYMENTS]: {
		student: { screen: NotificationScreen.RENT, web: "/student/home/rent", mobile: "/(app)/(tabs)/rent" },
		landlord: { screen: NotificationScreen.LANDLORD_RENT, web: "/rent" }
	},
	[NotificationTargetKind.COMPLIANCE]: {
		student: { screen: NotificationScreen.DEPOSIT, web: "/student/home/deposit", mobile: "/(app)/deposit" },
		landlord: { screen: NotificationScreen.DASHBOARD, web: "/dashboard" }
	},
	[NotificationTargetKind.TENANCY]: {
		student: { screen: NotificationScreen.HOME, web: "/student/home", mobile: "/(app)/(tabs)/my-home" },
		landlord: { screen: NotificationScreen.CONTRACTS, web: "/contracts" }
	},
	[NotificationTargetKind.CONTRACTS]: {
		student: { screen: NotificationScreen.CONTRACT, web: "/student/home", mobile: "/(app)/contract" },
		landlord: { screen: NotificationScreen.CONTRACTS, web: "/contracts" }
	},
	[NotificationTargetKind.REPAIRS]: {
		student: { screen: NotificationScreen.REPAIRS, web: "/student/home", mobile: "/(app)/repairs" },
		landlord: { screen: NotificationScreen.DASHBOARD, web: "/dashboard" }
	},
	[NotificationTargetKind.APPLICATION]: {
		student: { screen: NotificationScreen.APPLICATIONS, web: "/student/home", mobile: "/(app)/(tabs)/applied" },
		landlord: { screen: NotificationScreen.APPLICATION, web: "/applicants" }
	}
};

export function linkFor(audience: Audience, kind: NotificationTargetKind, id?: string, listing?: string): string {
	if (kind === NotificationTargetKind.APPLICATION && audience === "landlord" && id && listing) {
		return `/application?listing=${encodeURIComponent(listing)}&id=${encodeURIComponent(id)}`;
	}
	return NOTIFICATION_ROUTES[kind][audience].web;
}

/** `{ link, target }` to spread into a notification or activity item. */
export function notificationTarget(
	audience: Audience,
	kind: NotificationTargetKind,
	id?: { toString(): string } | string,
	options: { listing?: { toString(): string } | string | null } = {}
) {
	const value = id === undefined || id === null ? undefined : id.toString();
	const listing = options.listing ? options.listing.toString() : undefined;
	const route = NOTIFICATION_ROUTES[kind][audience];
	return {
		link: linkFor(audience, kind, value, listing),
		target: {
			kind,
			screen: route.screen,
			...(value ? { id: value } : {}),
			...(listing ? { listing } : {}),
			...(route.mobile ? { mobile: route.mobile } : {})
		} as NotificationTarget
	};
}
