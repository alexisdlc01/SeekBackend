import { MailFull } from "./providers/mail-provider";

/**
 * Sample housing mailbox for local development (provider DEMO). The emails
 * are built from the user's real tenancies and applications and go through
 * the same filter and filing pipeline as Gmail and Outlook. One non-housing
 * email is included so the filter visibly drops something.
 */
export interface DemoPerson {
	name: string;
	email: string;
}

export interface DemoHome {
	title: string;
	depositPence: number;
	depositReference: string | null;
	depositScheme: string | null;
	billsIncluded: boolean;
}

export interface DemoContext {
	mailbox: string;
	firstName: string;
	now: Date;
	/** Student: their landlord and home. */
	landlord?: DemoPerson;
	home?: DemoHome;
	householdEmails?: string[];
	universityDomain?: string;
	universityName?: string;
	/** Landlord: a tenant, an applicant and the home they let. */
	isLandlord?: boolean;
	tenant?: DemoPerson;
	applicant?: DemoPerson;
}

/** Demo files are not real documents; they point at a local placeholder. */
export const DEMO_FILE_BASE = "https://example.com/local/email";

const MONTHS = [
	"January", "February", "March", "April", "May", "June",
	"July", "August", "September", "October", "November", "December"
];

function hoursAgo(now: Date, hours: number) {
	return new Date(now.getTime() - hours * 3_600_000);
}

function pounds(pence: number) {
	return `£${(pence / 100).toFixed(pence % 100 === 0 ? 0 : 2)}`;
}

function first(name: string) {
	return name.trim().split(/\s+/)[0] || name;
}

function mail(
	ctx: DemoContext,
	id: string,
	fields: Omit<MailFull, "providerMessageId" | "providerThreadId" | "internetMessageId" | "attachments" | "snippet"> & {
		thread?: string;
		files?: string[];
	}
): MailFull {
	const { thread, files, ...rest } = fields;
	return {
		providerMessageId: `demo-${id}`,
		providerThreadId: `demo-thread-${thread ?? id}`,
		internetMessageId: `<demo-${id}@seek.local>`,
		snippet: rest.body.replace(/\s+/g, " ").slice(0, 140),
		attachments: (files ?? []).map(name => ({
			name,
			mimeType: "application/pdf",
			size: 0,
			load: async () => null
		})),
		...rest,
		to: rest.to.length ? rest.to : [ctx.mailbox]
	};
}

/** Builds the sample mailbox. Ids are stable so a re-sync imports nothing new. */
export function demoMailbox(ctx: DemoContext): MailFull[] {
	const { now } = ctx;
	const lastMonth = MONTHS[(now.getUTCMonth() + 11) % 12];
	const messages: MailFull[] = [];
	const homeTitle = ctx.home?.title ?? "your home";

	if (ctx.landlord) {
		messages.push(
			mail(ctx, "landlord-boiler", {
				thread: "boiler",
				from: ctx.landlord.email,
				fromName: ctx.landlord.name,
				to: [ctx.mailbox],
				subject: "Re: Boiler",
				body: `Thanks ${ctx.firstName}, sorry about that. The engineer can do Tuesday 9–11am. Gas safety certificate attached for your records.\n\n${first(ctx.landlord.name)}`,
				receivedAt: hoursAgo(now, 2),
				files: ["Gas-safety-2026.pdf"]
			}),
			mail(ctx, "landlord-agreement", {
				thread: "agreement",
				from: ctx.landlord.email,
				fromName: ctx.landlord.name,
				to: [ctx.mailbox, ...(ctx.householdEmails ?? [])],
				subject: "Tenancy agreement",
				body: `Hi all, attached is the signed agreement for ${homeTitle}. Welcome!\n\n${first(ctx.landlord.name)}`,
				receivedAt: hoursAgo(now, 24 * 74),
				files: ["Tenancy-agreement.pdf"]
			})
		);
	}

	if (ctx.home && !ctx.isLandlord) {
		if (ctx.home.depositReference && ctx.home.depositPence > 0) {
			messages.push(
				mail(ctx, "dps", {
					from: "noreply@depositprotection.com",
					fromName: "Deposit Protection Service",
					to: [ctx.mailbox],
					subject: "Your deposit is protected",
					body: `Your deposit of ${pounds(ctx.home.depositPence)} for ${homeTitle} is protected. Reference ${ctx.home.depositReference}.\n\nYour certificate is attached. Keep it until the end of your tenancy.`,
					receivedAt: hoursAgo(now, 26),
					files: ["DPS-certificate.pdf"]
				})
			);
		}
		messages.push(
			mail(ctx, "octopus", {
				from: "hello@octopus.energy",
				fromName: "Octopus Energy",
				to: [ctx.mailbox],
				subject: `Your ${lastMonth} statement`,
				body: `Your ${lastMonth} statement for ${homeTitle} is ready. Usage: 312 kWh.\n\nTotal: £214.00${ctx.home.billsIncluded ? " (paid by your landlord, bills are included in your rent)." : "."}`,
				receivedAt: hoursAgo(now, 50),
				files: [`Statement-${lastMonth.slice(0, 3)}.pdf`]
			})
		);
	}

	if (ctx.universityDomain) {
		const year = now.getUTCMonth() >= 7 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
		messages.push(
			mail(ctx, "uni-council-tax", {
				from: `studentservices@${ctx.universityDomain}`,
				fromName: `${ctx.universityName ?? "University"} Student Services`,
				to: [ctx.mailbox],
				subject: `Council tax exemption certificate ${year}–${String(year + 1).slice(2)}`,
				body: `Dear ${ctx.firstName},\n\nAttached is your council tax exemption certificate for ${year}–${String(year + 1).slice(2)}. Send it to your council if they ask for it.\n\nStudent Services`,
				receivedAt: hoursAgo(now, 24 * 4),
				files: ["Council-tax-exemption.pdf"]
			})
		);
	}

	if (ctx.tenant) {
		messages.push(
			mail(ctx, "tenant-boiler", {
				thread: "tenant-boiler",
				from: ctx.tenant.email,
				fromName: ctx.tenant.name,
				to: [ctx.mailbox],
				subject: "Re: Boiler",
				body: `Tuesday 9–11am works, someone will be in. Thanks!\n\n${first(ctx.tenant.name)}`,
				receivedAt: hoursAgo(now, 1)
			})
		);
		if (ctx.home?.depositReference) {
			messages.push(
				mail(ctx, "dps-landlord", {
					from: "noreply@depositprotection.com",
					fromName: "Deposit Protection Service",
					to: [ctx.mailbox],
					subject: "Deposit protection certificate",
					body: `The deposit of ${pounds(ctx.home.depositPence)} for ${homeTitle} is protected. Reference ${ctx.home.depositReference}.\n\nThe deposit protection certificate is attached. Give your tenants a copy and the prescribed information within 30 days.`,
					receivedAt: hoursAgo(now, 26),
					files: ["DPS-certificate.pdf"]
				})
			);
		}
	}

	if (ctx.applicant) {
		messages.push(
			mail(ctx, "applicant-guarantor", {
				thread: "applicant-guarantor",
				from: ctx.applicant.email,
				fromName: ctx.applicant.name,
				to: [ctx.mailbox],
				subject: "Re: Guarantor form",
				body: `Hi, my guarantor has signed the form. It's attached.\n\n${first(ctx.applicant.name)}`,
				receivedAt: hoursAgo(now, 20),
				files: ["Guarantor-form.pdf"]
			})
		);
	}

	messages.push(
		mail(ctx, "newsletter", {
			from: "no-reply@spotify.com",
			fromName: "Spotify",
			to: [ctx.mailbox],
			subject: "Your weekly mixtape is ready",
			body: "Fresh tracks picked for you.",
			receivedAt: hoursAgo(now, 30)
		})
	);

	return messages;
}

/** Email domains of the universities the search parser knows, for the demo mailbox. */
export const UNIVERSITY_DOMAINS: Record<string, string> = {
	"University of Bristol": "bristol.ac.uk",
	"UWE Bristol": "uwe.ac.uk",
	UCL: "ucl.ac.uk",
	"King's College London": "kcl.ac.uk",
	"Imperial College London": "imperial.ac.uk",
	LSE: "lse.ac.uk",
	"University of Manchester": "manchester.ac.uk",
	"University of Leeds": "leeds.ac.uk",
	"University of Edinburgh": "ed.ac.uk",
	"University of Glasgow": "gla.ac.uk",
	"Cardiff University": "cardiff.ac.uk",
	"University of Oxford": "ox.ac.uk",
	"University of Cambridge": "cam.ac.uk",
	"University of Birmingham": "bham.ac.uk",
	"University of Nottingham": "nottingham.ac.uk",
	"University of Sheffield": "sheffield.ac.uk",
	"University of Liverpool": "liverpool.ac.uk",
	"University of Exeter": "exeter.ac.uk",
	"University of York": "york.ac.uk"
};
