import { ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { User } from "../users/users.schema";
import { Role } from "../auth/role.enum";
import { ListingsService, ListingWithCoordinates } from "../listings/listings.service";
import { ListingFilterDto } from "../listings/dto/listing-filter.dto";
import { Listing } from "../listings/listings.schema";
import { Nation } from "../listings/enums/nation.enum";
import { Tenancy } from "../tenancies/tenancy.schema";
import { DepositScheme, TenancyDocumentType, TenancyStatus } from "../tenancies/tenancy.enums";
import { TenanciesService } from "../tenancies/tenancies.service";
import { depositCapPence, depositProtectionDeadline, depositProtectionWindow } from "../tenancies/compliance";
import { Bill, BillStatus } from "../bills/bill.schema";
import { Payment } from "../payments/payment.schema";
import { PaymentStatus } from "../payments/payment.enums";
import { computeFee } from "../payments/schedule";
import { formatPence } from "../payments/payments.service";
import { Application } from "../application/application.schema";
import { ApplicationStage } from "../application/enums/application-stage.enum";
import { EmailMessage } from "../inbox/email-message.schema";
import { EmailCategory } from "../inbox/email-category.enum";
import { ConnectionStatus, EmailConnection } from "../connectors/email-connection.schema";
import { ConnectorsService } from "../connectors/connectors.service";
import { Message } from "../conversation/message.schema";
import { ConversationAccessService } from "../conversation/conversation-access.service";
import { suggestReply } from "../inbox/suggest-reply";
import { ChatTurn } from "./anthropic.client";
import { LlmClient, LlmProvider } from "./llm.client";
import { matchHome } from "./listing-match";
import { householdReadiness, ReadinessCriteria } from "../application/readiness";
import { buildPassport, PassportDocumentInput } from "../users/passport";
import {
	AREAS,
	SearchFilters,
	UNIVERSITIES,
	describeFilters,
	extractJsonObject,
	findUniversity,
	parseConversation,
	sanitizeFilters
} from "./search-parser";
import { AdviceRequestDto, AdviceTopic } from "./dto/ai.dto";

type Viewer = Pick<User, "_id" | "name" | "role">;
type TenancyLean = Tenancy & { _id: Types.ObjectId };
type ListingLean = Listing & { _id: Types.ObjectId };

export interface AdviceAction {
	label: string;
	link: string;
}

export interface AdviceDraft {
	title: string;
	advice: string;
	actions: AdviceAction[];
	/**
	 * What the model may see instead of the draft, and text appended after
	 * its answer. Used to keep email bodies (and attachment names) away from
	 * the model unless AI_SEND_EMAIL_CONTENT=true.
	 */
	llm?: { facts: Record<string, unknown>; suffix?: string };
	/** Inbox threads: a reply to the last message received, ready to edit. */
	suggestedReply?: string | null;
}

/** How far from a university a home can be to count as "near" it. */
const NEAR_UNIVERSITY_KM = 5;
const MAX_RESULTS = 12;
const DAY_MS = 86_400_000;

const SCHEME_SITES: Record<DepositScheme, { name: string; url: string }> = {
	[DepositScheme.DPS]: { name: "DPS", url: "https://www.depositprotection.com" },
	[DepositScheme.TDS]: { name: "TDS", url: "https://www.tenancydepositscheme.com" },
	[DepositScheme.MYDEPOSITS]: { name: "mydeposits", url: "https://www.mydeposits.co.uk" },
	[DepositScheme.SAFEDEPOSITS_SCOTLAND]: { name: "SafeDeposits Scotland", url: "https://www.safedepositsscotland.com" },
	[DepositScheme.LPS_SCOTLAND]: { name: "Letting Protection Service Scotland", url: "https://www.lettingprotectionscotland.com" },
	[DepositScheme.MYDEPOSITS_SCOTLAND]: { name: "mydeposits Scotland", url: "https://www.mydepositsscotland.co.uk" }
};
/** Model output telling a student to protect the deposit themselves (it is the landlord's duty). */
export const STUDENT_PROTECTS_DEPOSIT = /(^|[.!?]\s+)protect (your|the) deposit/i;
const SCOTTISH_SCHEMES = [DepositScheme.SAFEDEPOSITS_SCOTLAND, DepositScheme.LPS_SCOTLAND, DepositScheme.MYDEPOSITS_SCOTLAND];

/** Deposit law of the nation the home is in: Scotland differs on cap, deadline and schemes. */
function depositRules(nation?: unknown) {
	const scotland = nation === Nation.SCOTLAND;
	const sites = (Object.keys(SCHEME_SITES) as DepositScheme[])
		.filter(key => SCOTTISH_SCHEMES.includes(key) === scotland)
		.map(key => SCHEME_SITES[key]);
	const names = sites.map(site => site.name);
	return {
		sites,
		schemes: `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`,
		window: depositProtectionWindow(nation),
		cap: scotland ? "two months' rent" : "five weeks' rent",
		deadlineName: scotland ? "30-working-day" : "30-day"
	};
}

const GUARANTOR_LINKS: AdviceAction[] = [
	{ label: "Housing Hand", link: "https://www.housinghand.co.uk" },
	{ label: "Your Guarantor", link: "https://www.yourguarantor.co.uk" },
	{ label: "Guarantid", link: "https://www.guarantid.com" }
];

const SEARCH_SYSTEM_PROMPT = (today: string) => `You help UK students find rented homes on Seek.
Read the whole conversation and work out the search the student wants now (later messages override earlier ones).
Answer with one JSON object and nothing else:
{"reply": string, "filters": {"city"?: string, "area"?: string, "maxRent"?: number, "minBedrooms"?: number, "billsIncluded"?: boolean, "nearUniversity"?: string, "moveIn"?: string}}
Rules:
- area is a neighbourhood the student named (e.g. ${AREAS.map(a => `${a.name} (${a.city})`).join(", ")}). Set city to the area's city.
- "St Andrews" on its own is the Scottish town: city "St Andrews", no area. It is the Bristol neighbourhood only when the student also says Bristol.
- maxRent is the monthly rent per person in whole pounds. Convert weekly amounts (x52/12).
- minBedrooms is a whole number.
- nearUniversity must be one of: ${UNIVERSITIES.map(u => u.name).join("; ")}. Set city to that university's city.
- moveIn is YYYY-MM-DD. Today is ${today}; a month without a year means its next occurrence.
- Leave out any filter the student did not ask for. Never invent one.
- reply: one or two short sentences in British English that restate the search, plus at most one question about something important that is missing (area or budget). Do not mention how many homes there are; the app adds that.`;

/** Gemini responseSchema for the search answer (OpenAPI subset). */
const SEARCH_RESPONSE_SCHEMA = {
	type: "OBJECT",
	properties: {
		reply: { type: "STRING" },
		filters: {
			type: "OBJECT",
			properties: {
				city: { type: "STRING", nullable: true },
				area: { type: "STRING", nullable: true },
				maxRent: { type: "NUMBER", nullable: true },
				minBedrooms: { type: "INTEGER", nullable: true },
				billsIncluded: { type: "BOOLEAN", nullable: true },
				nearUniversity: { type: "STRING", nullable: true },
				moveIn: { type: "STRING", nullable: true }
			}
		}
	},
	required: ["reply", "filters"]
};

/** Whether any student message names this place, e.g. "Bristol". */
function mentionsPlace(messages: ChatTurn[], place: string) {
	const pattern = new RegExp(`\\b${place.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+")}\\b`, "i");
	return messages.some(message => message.role === "user" && pattern.test(message.content));
}

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
	const rad = (deg: number) => (deg * Math.PI) / 180;
	const dLat = rad(b.lat - a.lat);
	const dLng = rad(b.lng - a.lng);
	const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
	return 6371 * 2 * Math.asin(Math.sqrt(h));
}

function formatDate(date: Date) {
	return new Date(date).toLocaleDateString("en-GB", {
		day: "numeric",
		month: "long",
		year: "numeric",
		timeZone: "Europe/London"
	});
}

/** Whole pounds without pence when there are none: £801, £801.92. */
function money(pence: number) {
	return pence % 100 === 0 ? `£${(pence / 100).toFixed(0)}` : formatPence(pence);
}

@Injectable()
export class AiService {
	private readonly logger = new Logger(AiService.name);

	constructor(
		private readonly llm: LlmClient,
		private readonly listings: ListingsService,
		private readonly tenancies: TenanciesService,
		@InjectModel(Tenancy.name) private readonly tenancyModel: Model<Tenancy>,
		@InjectModel(Listing.name) private readonly listingModel: Model<Listing>,
		@InjectModel(Bill.name) private readonly billModel: Model<Bill>,
		@InjectModel(Payment.name) private readonly paymentModel: Model<Payment>,
		@InjectModel(Application.name) private readonly applicationModel: Model<Application>,
		@InjectModel(EmailMessage.name) private readonly emailModel: Model<EmailMessage>,
		@InjectModel(EmailConnection.name) private readonly connectionModel: Model<EmailConnection>,
		private readonly config: ConfigService,
		@InjectModel(Message.name) private readonly messageModel?: Model<Message>,
		private readonly connectors?: ConnectorsService,
		private readonly conversationAccess?: ConversationAccessService
	) {}

	/** GDPR: email bodies go to the model only when AI_SEND_EMAIL_CONTENT=true. */
	private sendEmailContent() {
		return this.config.get<string>("AI_SEND_EMAIL_CONTENT")?.trim().toLowerCase() === "true";
	}

	// ---------------------------------------------------------------- search chat

	/** `student` (their Seek Passport documents) adds a per-listing check against the landlord's criteria. */
	async searchChat(messages: ChatTurn[], now = new Date(), student?: { documents?: PassportDocumentInput[] }) {
		const fromModel = await this.filtersFromModel(messages, now);
		const filters = fromModel?.filters ?? parseConversation(messages, now);
		const { listings, relaxed } = await this.findListings(filters, student);

		const described = describeFilters(filters);
		const countLine = listings.length
			? `I found ${listings.length === MAX_RESULTS ? `${MAX_RESULTS}+` : listings.length} home${listings.length === 1 ? "" : "s"}${
					relaxed.length ? ` once I dropped ${relaxed.map(key => (key === "billsIncluded" ? "bills included" : "the bedroom count")).join(" and ")}` : ""
				}.`
			: "Nothing on Seek matches that yet. Try a higher budget or a wider area.";
		let reply: string;
		if (fromModel) {
			reply = `${fromModel.reply} ${countLine}`;
		} else {
			const lead = described ? `Looking for homes ${described}.` : "Here are the latest homes on Seek.";
			const question = !filters.city
				? " Which city or university should I search near?"
				: !filters.maxRent
					? " What's your monthly budget per person?"
					: "";
			reply = `${lead} ${countLine}${question}`;
		}

		return {
			reply,
			filters,
			listings,
			relaxed,
			suggestions: quickReplies(filters),
			source: fromModel ? ("ai" as const) : ("rules" as const),
			provider: fromModel?.provider ?? ("rules" as const)
		};
	}

	private async filtersFromModel(
		messages: ChatTurn[],
		now: Date
	): Promise<{ filters: SearchFilters; reply: string; provider: LlmProvider } | null> {
		if (!this.llm.isConfigured()) return null;
		const answer = await this.llm.complete({
			system: SEARCH_SYSTEM_PROMPT(now.toISOString().slice(0, 10)),
			messages,
			maxTokens: 400,
			responseSchema: SEARCH_RESPONSE_SCHEMA
		});
		if (!answer) return null;
		const parsed = extractJsonObject(answer.text) as { reply?: unknown; filters?: unknown } | null;
		if (!parsed || typeof parsed !== "object") return null;
		const raw: Record<string, unknown> =
			parsed.filters && typeof parsed.filters === "object" ? { ...(parsed.filters as Record<string, unknown>) } : {};
		// Gemini sometimes fills schema fields it has no value for with debris ("", ": null"): treat them as absent.
		for (const [key, value] of Object.entries(raw)) {
			if (typeof value === "string" && (!/^[\p{L}\p{N}]/u.test(value.trim()) || /^(null|none|undefined)$/i.test(value.trim()))) {
				delete raw[key];
			}
		}
		const sanitized = sanitizeFilters(raw);
		const reply = typeof parsed.reply === "string" ? parsed.reply.trim() : "";
		if (!sanitized || !reply || reply.length > 400) {
			this.logger.warn(`AI search answer from ${answer.provider} was not usable; using the rules parser.`);
			return null;
		}
		// The rules parser only reads what the student wrote, so it can fill a filter the model dropped.
		const rules = parseConversation(messages, now);
		// A city the student never wrote must not replace one they did ("St Andrews" read as the Bristol neighbourhood).
		if (rules.city && sanitized.city && sanitized.city !== rules.city && !mentionsPlace(messages, sanitized.city)) {
			this.logger.warn(`AI search answer from ${answer.provider} moved the search to ${sanitized.city}; using the rules parser.`);
			return null;
		}
		const filters = { ...rules, ...sanitized };
		return { filters, reply, provider: answer.provider };
	}

	/** Runs the search; when nothing matches, drops bills, then bedrooms. */
	private async findListings(filters: SearchFilters, student?: { documents?: PassportDocumentInput[] }) {
		const relaxed: string[] = [];
		let current = { ...filters };
		let results = await this.queryListings(current, student);
		for (const key of ["billsIncluded", "minBedrooms"] as const) {
			if (results.length || current[key] === undefined) continue;
			const { [key]: _dropped, ...rest } = current;
			current = rest;
			relaxed.push(key);
			results = await this.queryListings(current, student);
		}
		return { listings: results.slice(0, MAX_RESULTS), relaxed };
	}

	private async queryListings(filters: SearchFilters, student?: { documents?: PassportDocumentInput[] }) {
		const query: Partial<ListingFilterDto> = { limit: 60 };
		if (filters.city) query.city = filters.city;
		if (filters.maxRent) query.maxRent = filters.maxRent;
		if (filters.minBedrooms) query.minBedrooms = filters.minBedrooms;
		if (typeof filters.billsIncluded === "boolean") query.billsIncluded = filters.billsIncluded;
		if (filters.area) query.text = filters.area;
		const found = await this.listings.filters(query as ListingFilterDto);

		const university = filters.nearUniversity ? findUniversity(filters.nearUniversity) : undefined;
		const moveIn = filters.moveIn ? new Date(`${filters.moveIn}T00:00:00Z`) : null;
		return found
			.map(listing => ({
				listing,
				distanceKm:
					university && listing.lat !== null && listing.lng !== null
						? Math.round(haversineKm(university, { lat: listing.lat, lng: listing.lng }) * 10) / 10
						: null
			}))
			.filter(({ distanceKm }) => !university || (distanceKm !== null && distanceKm <= NEAR_UNIVERSITY_KM))
			.filter(({ listing }) => {
				if (!moveIn) return true;
				const from = listing.availableFrom ? new Date(listing.availableFrom) : null;
				const until = listing.availableUntil ? new Date(listing.availableUntil) : null;
				// Available by the move-in date, give or take a fortnight.
				return (!from || from.getTime() <= moveIn.getTime() + 14 * DAY_MS) && (!until || until >= moveIn);
			})
			.sort((a, b) => (a.distanceKm ?? 0) - (b.distanceKm ?? 0))
			.map(({ listing, distanceKm }) => ({ ...this.summary(listing, distanceKm, filters), checks: listingChecks(listing, filters, student) }));
	}

	private summary(
		listing: ListingWithCoordinates & { _id?: Types.ObjectId },
		distanceKm: number | null,
		filters: SearchFilters = {}
	) {
		const fit = matchHome(
			{
				rentPerPerson: listing.rentPerPerson ?? listing.monthlyRent ?? null,
				bedrooms: listing.bedroomsCount ?? null,
				billsIncluded: Boolean(listing.billsIncluded),
				availableFrom: listing.availableFrom ?? null,
				distanceKm
			},
			{ maxRent: filters.maxRent, minBedrooms: filters.minBedrooms, billsIncluded: filters.billsIncluded, moveInBy: filters.moveIn }
		);
		return {
			id: listing._id?.toString() ?? "",
			title: listing.propertyTitle || listing.streetAddress || "Home on Seek",
			address: listing.streetAddress ?? null,
			city: listing.cityTown ?? null,
			postcode: listing.postcodeZIP ?? null,
			lat: listing.lat,
			lng: listing.lng,
			monthlyRent: listing.monthlyRent ?? null,
			rentPerPerson: listing.rentPerPerson,
			bedrooms: listing.bedroomsCount ?? null,
			bathrooms: listing.bathrooms ?? null,
			billsIncluded: Boolean(listing.billsIncluded),
			availableFrom: listing.availableFrom ?? null,
			photo: listing.photos?.[0] ?? null,
			distanceKm,
			...fit
		};
	}

	// ---------------------------------------------------------------- advice

	async advice(user: Viewer, body: AdviceRequestDto, now = new Date()) {
		const draft = await this.draftAdvice(user, body, now);
		const rewritten = await this.rewrite(user, body.topic, draft, body.question?.trim() || undefined);
		return {
			title: draft.title,
			advice: rewritten ? `${rewritten.advice}${draft.llm?.suffix ?? ""}` : draft.advice,
			...(draft.actions.length ? { actions: draft.actions } : {}),
			source: rewritten ? ("ai" as const) : ("rules" as const),
			provider: rewritten?.provider ?? ("rules" as const),
			...(draft.suggestedReply !== undefined ? { suggestedReply: draft.suggestedReply } : {})
		};
	}

	private async draftAdvice(user: Viewer, body: AdviceRequestDto, now: Date): Promise<AdviceDraft> {
		if (body.topic === "inbox") {
			const draft = await this.inboxAdvice(user, body.threadId);
			return body.threadId ? { ...draft, suggestedReply: await this.threadReply(user, body.threadId) } : draft;
		}
		if (body.topic === "guarantor") return this.guarantorAdvice(user);
		if (body.topic === "application") {
			return body.applicationId ? this.householdAdvice(user, body.applicationId, now) : this.applicationAdvice(user, now);
		}
		const tenancy = await this.findTenancy(user, body.tenancyId);
		const listing = tenancy
			? ((await this.listingModel
					.findById(tenancy.listing)
					.select("propertyTitle streetAddress cityTown billsIncluded nation")
					.lean()
					.exec()) as ListingLean | null)
			: null;
		const handlers: Record<Exclude<AdviceTopic, "inbox" | "guarantor" | "application">, () => Promise<AdviceDraft> | AdviceDraft> = {
			deposit: () => this.depositAdvice(user, tenancy, listing, now),
			bills: () => this.billsAdvice(user, tenancy, listing),
			contract: () => this.contractAdvice(user, tenancy, listing),
			rent: () => this.rentAdvice(user, tenancy, listing, now)
		};
		return handlers[body.topic]();
	}

	private async findTenancy(user: Viewer, tenancyId?: string): Promise<TenancyLean | null> {
		if (tenancyId) return this.tenancies.findForMember(tenancyId, user);
		const uid = new Types.ObjectId(user._id.toString());
		const filter = user.role === Role.LANDLORD_AGENCY ? { landlord: uid } : { tenants: uid };
		return (await this.tenancyModel
			.findOne({ ...filter, status: TenancyStatus.ACTIVE })
			.sort({ startDate: -1 })
			.lean()
			.exec()) as TenancyLean | null;
	}

	private isLandlord(user: Viewer) {
		return user.role === Role.LANDLORD_AGENCY;
	}

	private homeLink(user: Viewer) {
		return this.isLandlord(user) ? "/dashboard" : "/student/home";
	}

	private homeName(listing: ListingLean | null) {
		return listing?.propertyTitle || listing?.streetAddress || "your home";
	}

	private hasDocument(tenancy: TenancyLean, type: TenancyDocumentType) {
		return (tenancy.documents ?? []).some(doc => doc.type === type);
	}

	private depositAdvice(user: Viewer, tenancy: TenancyLean | null, listing: ListingLean | null, now: Date): AdviceDraft {
		const nation = listing?.nation;
		const rules = depositRules(nation);
		const general =
			nation === Nation.SCOTLAND
				? `In Scotland a deposit can be at most two months' rent. It must be protected in an approved scheme (${rules.schemes}) within ${rules.window}, and the tenant must get the prescribed information.`
				: "A deposit can be at most five weeks' rent, and a holding deposit at most one week's. It must be protected in a government-approved scheme (DPS, TDS or mydeposits) within 30 days of being paid, and the tenant must get the certificate and prescribed information.";
		if (!tenancy) {
			return {
				title: "Deposits: the rules",
				advice: general,
				actions: rules.sites.map(site => ({ label: `Check a deposit with ${site.name}`, link: site.url }))
			};
		}
		const landlord = this.isLandlord(user);
		const home = this.homeName(listing);
		const cap = depositCapPence(tenancy.monthlyRent, nation);
		const deposit = tenancy.depositAmount ?? 0;
		const scheme = tenancy.depositScheme ? SCHEME_SITES[tenancy.depositScheme] : null;
		const protectedNow = Boolean(scheme && (tenancy.depositReference || tenancy.depositProtectedAt));
		// 30 days from when the deposit was received; unknown until it is recorded.
		const deadline = depositProtectionDeadline(tenancy, nation);
		const certificate = this.hasDocument(tenancy, TenancyDocumentType.DEPOSIT_CERTIFICATE);
		const subject = landlord ? `The deposit for ${home}` : "Your deposit";
		const lines: string[] = [];

		if (deposit <= 0) {
			lines.push(`${landlord ? `No deposit is recorded for ${home}.` : "No deposit is recorded for your tenancy."} ${general}`);
		} else {
			lines.push(
				protectedNow
					? `${subject} of ${money(deposit)} is protected with ${scheme!.name}${tenancy.depositReference ? ` (reference ${tenancy.depositReference})` : ""}.`
					: !deadline
						? `${subject} of ${money(deposit)} must be protected in ${rules.schemes} within ${nation === Nation.SCOTLAND ? rules.window : "30 days of being received"}. ${landlord ? "Record the date you received it so Seek can track the deadline." : "Ask your landlord when they received it and for the protection certificate."}`
						: deadline < now
						? `${subject} of ${money(deposit)} is not recorded as protected, and the ${rules.deadlineName} deadline passed on ${formatDate(deadline)}. ${landlord ? "Protect it now: late protection can mean a penalty of up to three times the deposit." : "Ask your landlord for the protection certificate; if it was never protected you may be owed up to three times the deposit."}`
						: `${subject} of ${money(deposit)} must be protected in ${rules.schemes} by ${formatDate(deadline)}.${landlord ? "" : " That is your landlord's legal duty, not yours: ask them for the scheme's certificate and the prescribed information, and check the reference on the scheme's website. If the date passes without them, tell your landlord in writing and contact the scheme or your university's advice service."}`
			);
			lines.push(
				deposit > cap
					? `That is more than the legal cap of ${rules.cap} (${money(cap)}). ${landlord ? `Refund the ${money(deposit - cap)} difference.` : `Ask for the ${money(deposit - cap)} difference back.`}`
					: `That is within the legal cap of ${rules.cap} (${money(cap)}).`
			);
			if (protectedNow) {
				lines.push(
					certificate
						? "The protection certificate is filed in your documents."
						: landlord
							? "Upload the protection certificate and give your tenants the prescribed information."
							: "Ask your landlord for the protection certificate and keep it until you move out."
				);
			}
		}

		const actions: AdviceAction[] = [];
		if (scheme) actions.push({ label: `Check it with ${scheme.name}`, link: scheme.url });
		actions.push({ label: certificate ? "Open your documents" : "Go to your tenancy", link: this.homeLink(user) });
		return {
			title: deposit <= 0 ? "Deposit" : protectedNow ? `${subject} is protected` : !deadline ? (landlord ? "Protect the deposit within 30 days" : "Your landlord must protect your deposit within 30 days") : deadline < now ? `${subject} is not protected` : landlord ? `Protect the deposit by ${formatDate(deadline)}` : `Your landlord must protect your deposit by ${formatDate(deadline)}`,
			advice: lines.join(" "),
			actions
		};
	}

	private async billsAdvice(user: Viewer, tenancy: TenancyLean | null, listing: ListingLean | null): Promise<AdviceDraft> {
		const landlord = this.isLandlord(user);
		// GOV.UK's page covers England and Wales; Scottish council tax is on mygov.scot.
		const councilTaxLink =
			listing?.nation === Nation.SCOTLAND
				? { label: "Council tax for students (mygov.scot)", link: "https://www.mygov.scot/council-tax/discounts-exemptions-and-reductions" }
				: { label: "Council tax for students (GOV.UK)", link: "https://www.gov.uk/council-tax/discounts-for-full-time-students" };
		const councilTaxRule =
			"Full-time students don't pay council tax, and a home where everyone is a full-time student is exempt. Each student gets an exemption certificate from their university.";
		if (!tenancy) {
			return { title: "Bills and council tax", advice: councilTaxRule, actions: [councilTaxLink] };
		}
		const home = this.homeName(listing);
		const bills = await this.billModel.find({ tenancy: tenancy._id }).sort({ createdAt: -1 }).lean().exec();
		const uid = user._id.toString();
		const splitOf = (bill: (typeof bills)[number]) => (bill.splitBetween?.length ? bill.splitBetween : tenancy.tenants).map(id => id.toString());
		// A tenant only counts bills where their own share is still unpaid.
		const due = bills.filter(bill => bill.status === BillStatus.DUE && !bill.includedInRent
			&& (landlord || (splitOf(bill).includes(uid) && !(bill.paidShares ?? []).some(id => id.toString() === uid))));
		const myShare = landlord ? 0 : due.reduce((sum, bill) => sum + Math.round(bill.amount / splitOf(bill).length), 0);
		const lines: string[] = [];

		if (listing?.billsIncluded) {
			const included = [...new Set(bills.filter(bill => bill.includedInRent).map(bill => bill.provider))];
			lines.push(
				landlord
					? `Bills are included in the rent at ${home}${included.length ? ` (${included.join(", ")})` : ""}, so you pay them.`
					: `Bills are included in your rent at ${home}${included.length ? ` (${included.join(", ")})` : ""}: your landlord pays them, you don't.`
			);
		} else {
			lines.push(`Bills are not included in the rent at ${home}, so the household splits them.`);
		}
		if (due.length) {
			const total = due.reduce((sum, bill) => sum + bill.amount, 0);
			lines.push(
				landlord
					? `${due.length} household bill${due.length === 1 ? " is" : "s are"} unpaid (${money(total)} in total).`
					: `${due.length} bill${due.length === 1 ? " is" : "s are"} unpaid; your share is ${money(myShare)}.`
			);
		}

		const certificates = (tenancy.documents ?? []).filter(doc => doc.type === TenancyDocumentType.COUNCIL_TAX_EXEMPTION).length;
		if (landlord) {
			lines.push(
				`If every tenant is a full-time student the property is exempt from council tax. ${certificates ? `${certificates} exemption certificate${certificates === 1 ? " is" : "s are"} on file.` : "No exemption certificates are on file yet."}`
			);
		} else {
			lines.push(
				certificates
					? "Your council tax exemption certificate is filed in your documents; send it to the council if they ask."
					: `${councilTaxRule} Ask your university for yours.`
			);
		}
		return {
			title: listing?.billsIncluded ? "Bills are included in your rent" : "Your household bills",
			advice: lines.join(" "),
			actions: [{ label: "See household bills", link: this.homeLink(user) }, councilTaxLink]
		};
	}

	private contractAdvice(user: Viewer, tenancy: TenancyLean | null, listing: ListingLean | null): AdviceDraft {
		const landlord = this.isLandlord(user);
		const england = !listing?.nation || listing.nation === Nation.ENGLAND;
		const rules = landlord
			? "Under the Renters' Rights Act, tenancies in England are periodic: they roll on month to month with no fixed end date. Tenants can leave with two months' written notice. You can only end a tenancy using a legal ground (no-fault Section 21 notices have ended), and most grounds, such as selling or moving in, need four months' notice. Rent in advance is capped at one month."
			: "Under the Renters' Rights Act, tenancies in England are periodic: they roll on month to month with no fixed end date. You can leave by giving two months' notice in writing. Your landlord can only end the tenancy using a legal ground (no-fault Section 21 evictions have ended), and most grounds, such as selling, need four months' notice. Rent in advance is capped at one month.";
		const actions: AdviceAction[] = [
			{ label: "Open your contract", link: "/contracts" },
			{ label: "Renting privately (GOV.UK)", link: "https://www.gov.uk/private-renting" }
		];
		if (!tenancy) return { title: "Your tenancy rights", advice: england ? rules : "Notice rules differ in Wales, Scotland and Northern Ireland; check your agreement and official guidance for your nation.", actions };

		const lines: string[] = [];
		const home = this.homeName(listing);
		lines.push(
			`${landlord ? `The tenancy at ${home}` : `Your tenancy at ${home}`} started on ${formatDate(tenancy.startDate)}${
				tenancy.endDate && !tenancy.periodic ? ` and the agreement names ${formatDate(tenancy.endDate)} as its end date` : " and is periodic"
			}.`
		);
		if (england) {
			lines.push(rules);
			if (tenancy.endDate && !tenancy.periodic) {
				lines.push("A fixed end date no longer ends a tenancy in England on its own: someone still has to give notice.");
			}
		} else {
			lines.push("This home is outside England, where notice rules differ; check your agreement and official guidance for your nation.");
		}
		lines.push(
			this.hasDocument(tenancy, TenancyDocumentType.TENANCY_AGREEMENT)
				? "The signed agreement is in your documents."
				: landlord
					? "No signed agreement is on file yet; send one through Seek."
					: "No signed agreement is on file yet; ask your landlord for it."
		);
		return { title: "Your tenancy and notice", advice: lines.join(" "), actions };
	}

	private async applicationAdvice(user: Viewer, now: Date): Promise<AdviceDraft> {
		const uid = new Types.ObjectId(user._id.toString());
		if (this.isLandlord(user)) {
			const applications = await this.applicationModel
				.find({ landlord: uid, stage: { $in: [ApplicationStage.SENT, ApplicationStage.VIEWED, ApplicationStage.OFFERED, ApplicationStage.ACCEPTED] } })
				.select("stage offerExpiresAt")
				.lean()
				.exec();
			const count = (stage: ApplicationStage) => applications.filter(app => app.stage === stage).length;
			const lines: string[] = [];
			if (!applications.length) lines.push("You have no open applications.");
			if (count(ApplicationStage.SENT)) lines.push(`${count(ApplicationStage.SENT)} new application${count(ApplicationStage.SENT) === 1 ? " is" : "s are"} waiting for a viewing or a decision.`);
			if (count(ApplicationStage.VIEWED)) lines.push(`${count(ApplicationStage.VIEWED)} household${count(ApplicationStage.VIEWED) === 1 ? " has" : "s have"} viewed and can be offered the home.`);
			if (count(ApplicationStage.OFFERED)) lines.push(`${count(ApplicationStage.OFFERED)} offer${count(ApplicationStage.OFFERED) === 1 ? " is" : "s are"} out.`);
			if (count(ApplicationStage.ACCEPTED)) lines.push(`${count(ApplicationStage.ACCEPTED)} accepted offer${count(ApplicationStage.ACCEPTED) === 1 ? " is" : "s are"} ready for a tenancy agreement.`);
			lines.push("In England you can't charge applicants for referencing, and a holding deposit is capped at one week's rent.");
			return {
				title: applications.length ? `${applications.length} open application${applications.length === 1 ? "" : "s"}` : "Applications",
				advice: lines.join(" "),
				actions: [{ label: "Open applicants", link: "/applicants" }]
			};
		}
		const applications = await this.applicationModel
			.find({ $or: [{ applicants: uid }, { owner: uid }], stage: { $ne: ApplicationStage.REJECTED } })
			.select("listing stage viewingAt offerExpiresAt holdingDeposit")
			.sort({ createdAt: -1 })
			.limit(10)
			.lean()
			.exec();
		const actions: AdviceAction[] = [{ label: "Find homes", link: "/student/find" }];
		if (!applications.length) {
			return {
				title: "Applying for a home",
				advice:
					"Apply together as a household so the landlord sees everyone at once. Have your ID, proof of study and a guarantor (or a guarantor service) ready. In England a holding deposit is capped at one week's rent and you can't be charged for referencing.",
				actions
			};
		}
		const listings = await this.listingModel
			.find({ _id: { $in: applications.map(app => app.listing) } })
			.select("propertyTitle streetAddress")
			.lean()
			.exec();
		const name = (id: Types.ObjectId) => this.homeName((listings.find(l => l._id.equals(id)) as ListingLean | undefined) ?? null);
		const lines = applications.slice(0, 4).map(app => {
			const home = name(app.listing);
			switch (app.stage) {
				case ApplicationStage.NOT_SENT:
					return `Your application for ${home} isn't sent yet; send it once everyone has joined.`;
				case ApplicationStage.SENT:
					return `${home}: sent, waiting for the landlord.`;
				case ApplicationStage.VIEWED:
					return app.viewingAt && new Date(app.viewingAt) > now
						? `${home}: viewing on ${formatDate(app.viewingAt)}.`
						: `${home}: viewed, waiting for an offer.`;
				case ApplicationStage.OFFERED:
					return `${home}: you have an offer${app.offerExpiresAt ? ` until ${formatDate(app.offerExpiresAt)}` : ""}. Accept it before it expires.`;
				case ApplicationStage.ACCEPTED:
					return `${home}: offer accepted; the landlord will send the tenancy agreement.`;
				case ApplicationStage.SIGNED:
					return `${home}: signed. Your tenancy is set up.`;
				default:
					return `${home}: ${app.stage.toLowerCase()}.`;
			}
		});
		lines.push("A holding deposit is capped at one week's rent and you can't be charged for referencing.");
		const offered = applications.some(app => app.stage === ApplicationStage.OFFERED);
		return {
			title: offered ? "You have an offer" : "Your applications",
			advice: lines.join(" "),
			actions: [{ label: "Open your home", link: "/student/home" }, ...actions]
		};
	}

	/** One household against its listing: each criterion and each member's Seek Passport (never document files). */
	private async householdAdvice(user: Viewer, applicationId: string, now: Date): Promise<AdviceDraft> {
		const application = await this.applicationModel
			.findById(applicationId)
			.populate({ path: "applicants", select: "name documents" })
			.lean()
			.exec();
		if (!application) throw new NotFoundException("Application not found");
		const uid = user._id.toString();
		const members = (application.applicants as unknown as { _id: Types.ObjectId; name?: string; documents?: PassportDocumentInput[] }[])
			.filter(member => member && typeof member === "object" && "_id" in member);
		const landlord = application.landlord?.toString() === uid;
		if (!landlord && !members.some(member => member._id.toString() === uid)) {
			throw new ForbiddenException("You are not part of this application");
		}
		const listing = (await this.listingModel
			.findById(application.listing)
			.select("propertyTitle streetAddress numOfPeople criteria")
			.lean()
			.exec()) as ListingLean | null;
		const home = this.homeName(listing);
		const household = householdReadiness(members, listing?.numOfPeople, now, listing?.criteria);
		const missing = household.criteria.filter(criterion => !criterion.passed);
		const lines = [
			household.qualified
				? `${landlord ? "This household" : "Your household"} of ${members.length} meets every criterion for ${home}.`
				: `${landlord ? "This household" : "Your household"} doesn't qualify for ${home} yet. Not met: ${missing.map(criterion => `${criterion.label} (${criterion.detail})`).join("; ")}.`
		];
		for (const member of members) {
			const passport = buildPassport(member.documents, now);
			const todo = passport.sections.flatMap(section => section.items).filter(item => passport.missingRequired.includes(item.type)).map(item => item.label);
			lines.push(passport.ready ? `${member.name ?? "A member"}: Seek Passport ready.` : `${member.name ?? "A member"}: still needs ${todo.join(", ")}.`);
		}
		lines.push(
			household.qualified
				? "Offers go to qualified households in the order they applied, with no bidding."
				: landlord
					? "Only qualified households can get an offer; Seek shows them what is missing."
					: "Your place in the queue counts once every member's passport is complete."
		);
		return {
			title: household.qualified ? "Household qualifies" : "Not qualified yet",
			advice: lines.join(" "),
			actions: landlord ? [{ label: "Open applicants", link: "/applicants" }] : [{ label: "Open your Seek Passport", link: "/student/profile" }]
		};
	}

	private async guarantorAdvice(user: Viewer): Promise<AdviceDraft> {
		const uid = new Types.ObjectId(user._id.toString());
		const actions = [...GUARANTOR_LINKS];
		if (this.isLandlord(user)) {
			return {
				title: "Guarantors",
				advice:
					"Many students, especially international students, don't have a UK guarantor. You can accept a guarantor service such as Housing Hand, Your Guarantor or Guarantid instead. In England you can't ask for more than one month's rent in advance as an alternative, and you can't charge applicants for referencing.",
				actions
			};
		}
		const applications = await this.applicationModel
			.find({ $or: [{ applicants: uid }, { owner: uid }] })
			.select("listing stage")
			.lean()
			.exec();
		const listings = await this.listingModel
			.find({ _id: { $in: applications.map(app => app.listing) } })
			.select("propertyTitle streetAddress requirements")
			.lean()
			.exec();
		const asking = listings.filter(listing =>
			(listing.requirements ?? []).some(req => /guarantor/i.test(`${req.name} ${req.desc}`))
		);
		const lead = asking.length
			? `${asking.map(l => l.propertyTitle || l.streetAddress).join(", ")} ${asking.length === 1 ? "asks" : "ask"} for a guarantor.`
			: "A guarantor agrees to pay the rent if you can't.";
		return {
			title: "Need a guarantor?",
			advice: `${lead} If you don't have one in the UK, a guarantor service such as Housing Hand, Your Guarantor or Guarantid can act as one for a fee. Landlords in England can't ask for more than one month's rent in advance instead, and can't charge you for referencing.`,
			actions
		};
	}

	private async rentAdvice(user: Viewer, tenancy: TenancyLean | null, listing: ListingLean | null, now: Date): Promise<AdviceDraft> {
		const landlord = this.isLandlord(user);
		if (!tenancy) {
			return {
				title: "Rent",
				advice: landlord
					? "Seek's fee is 0.5% of the rent collected, paid by you. Tenants pay no fee. In England rent in advance is capped at one month."
					: "On Seek you pay rent monthly with no fee; your landlord pays Seek's 0.5% fee. In England a landlord can't ask for more than one month's rent in advance.",
				actions: [{ label: "Open rent", link: "/rent" }]
			};
		}
		const home = this.homeName(listing);
		// monthlyRent is what each tenant pays (see tenancy.schema.ts).
		const tenants = Math.max(1, tenancy.tenants.length);
		const collected = tenancy.monthlyRent * tenants;
		const uid = new Types.ObjectId(user._id.toString());
		const open = await this.paymentModel
			.find({
				tenancy: tenancy._id,
				...(landlord ? {} : { tenant: uid }),
				status: { $in: [PaymentStatus.SCHEDULED, PaymentStatus.PENDING, PaymentStatus.LATE, PaymentStatus.FAILED] }
			})
			.sort({ dueDate: 1 })
			.lean()
			.exec();
		const late = open.filter(p => p.status === PaymentStatus.LATE || p.status === PaymentStatus.FAILED || p.dueDate < now);
		const next = open.find(p => p.dueDate >= now && p.status !== PaymentStatus.FAILED);
		const lines: string[] = [];
		if (landlord) {
			const fee = computeFee(collected).seekFee;
			lines.push(
				tenants > 1
					? `Rent at ${home} is ${money(tenancy.monthlyRent)} a month per tenant (${money(collected)} from ${tenants} tenants).`
					: `Rent at ${home} is ${money(tenancy.monthlyRent)} a month.`,
				`Seek's fee is 0.5% of rent collected (${money(fee)} a month), paid by you; tenants pay no fee.`
			);
			if (late.length) lines.push(`${late.length} payment${late.length === 1 ? " is" : "s are"} overdue.`);
		} else {
			lines.push(`Your rent is ${money(tenancy.monthlyRent)} a month.`);
			if (next) lines.push(`Next payment: ${money(next.amount)} on ${formatDate(next.dueDate)}.`);
			if (late.length) lines.push(`${late.length} payment${late.length === 1 ? " is" : "s are"} overdue; pay it or talk to your landlord before it builds up.`);
			lines.push("You pay no Seek fee.");
		}
		if (!listing?.nation || listing.nation === Nation.ENGLAND) {
			lines.push("In England rent in advance is capped at one month.");
		}
		return {
			title: late.length ? "Rent is overdue" : landlord ? `Rent at ${home}` : "Your rent",
			advice: lines.join(" "),
			actions: [{ label: "Open rent", link: "/rent" }]
		};
	}

	/** A reply to the last message someone else sent in the thread (email or Seek), unless AI replies are off. */
	private async threadReply(user: Viewer, threadId: string): Promise<string | null> {
		if (this.connectors && !(await this.connectors.settings(user)).aiDraftReplies) return null;
		const uid = new Types.ObjectId(user._id.toString());
		const id = threadId.toLowerCase();
		const seekId = id.startsWith("seek-") && Types.ObjectId.isValid(id.slice(5)) ? new Types.ObjectId(id.slice(5)) : null;
		const emailFilter = id.startsWith("email-") ? { threadKey: id.slice(6) } : seekId ? { conversation: seekId } : null;
		if (!emailFilter) return null;
		const email = await this.emailModel
			.findOne({ user: uid, outgoing: false, ...emailFilter })
			.sort({ receivedAt: -1 })
			.lean()
			.exec();
		let last = email
			? { text: `${email.subject}\n${email.body ?? ""}`, from: email.counterpartName || email.fromName || email.from, category: email.category, at: email.receivedAt }
			: null;
		if (seekId && this.messageModel && this.conversationAccess) {
			const allowed = await this.conversationAccess
				.assertCanAccess(seekId.toString(), uid.toString())
				.then(() => true)
				.catch(() => false);
			const message = allowed
				? await this.messageModel
						.findOne({ conversation: seekId, sender: { $ne: uid } })
						.sort({ createdAt: -1 })
						.populate<{ sender: { name?: string } | null }>({ path: "sender", select: "name" })
						.lean()
						.exec()
				: null;
			if (message && (!last || message.createdAt > last.at)) {
				last = { text: message.data, from: message.sender?.name ?? "", category: last?.category ?? EmailCategory.OTHER, at: message.createdAt };
			}
		}
		return last ? suggestReply({ text: last.text, category: last.category, fromName: last.from, landlord: this.isLandlord(user) }) : null;
	}

	private async inboxAdvice(user: Viewer, threadId?: string): Promise<AdviceDraft> {
		const uid = new Types.ObjectId(user._id.toString());
		const actions: AdviceAction[] = [{ label: "Open inbox", link: "/inbox" }];
		const email = threadId?.toLowerCase().startsWith("email-")
			? await this.emailModel
					.findOne({ user: uid, threadKey: threadId.slice(6).toLowerCase(), outgoing: false })
					.sort({ receivedAt: -1 })
					.lean()
					.exec()
			: threadId?.toLowerCase().startsWith("seek-") && Types.ObjectId.isValid(threadId.slice(5))
				? await this.emailModel
						.findOne({ user: uid, conversation: new Types.ObjectId(threadId.slice(5)), outgoing: false })
						.sort({ receivedAt: -1 })
						.lean()
						.exec()
				: null;

		if (email) {
			const filed = (email.attachments ?? []).filter(a => a.filedAs);
			const filedLine = filed.length ? ` ${filed.map(a => `${a.name} was filed in ${a.filedAs}.`).join(" ")}` : "";
			const from = email.counterpartName || email.fromName || email.from;
			const text = `${email.subject} ${email.body}`;
			const next: Partial<Record<EmailCategory, string>> = {
				[EmailCategory.DEPOSIT]: "Keep the deposit certificate until the tenancy ends and check the reference on the scheme's website.",
				[EmailCategory.BILLS]: "Check whether this bill is included in the rent before anyone pays it; otherwise split it in household bills.",
				[EmailCategory.UNIVERSITY]: "Keep your council tax exemption certificate and send it to the council if they ask.",
				[EmailCategory.APPLICANT]: "Check the document against your requirements before you accept the application.",
				[EmailCategory.HOUSEHOLD]: "Reply here so the whole household sees the answer."
			};
			const repair = /\b(boiler|leak|repair|broken|mould|heating|engineer)\b/i.test(text);
			const step = repair
				? this.isLandlord(user)
					? "Log the visit as a repair in Seek so there is a dated record for the tenants."
					: "Log it as a repair in Seek so there is a dated record if it happens again."
				: (next[email.category] ?? "Reply here; it goes out from your own email address.");
			if (repair) actions.push({ label: "Report a repair", link: this.homeLink(user) });
			const email_ = { subject: email.subject, from, date: formatDate(email.receivedAt) };
			return {
				title: `${from}: ${email.subject}`.slice(0, 120),
				advice: `${from} wrote on ${formatDate(email.receivedAt)}.${filedLine} ${step}`,
				actions,
				// Metadata only by default; the body (and attachment names) is
				// sent only when AI_SEND_EMAIL_CONTENT=true.
				llm: this.sendEmailContent()
					? { facts: { email: { ...email_, body: (email.body ?? "").slice(0, 4000) }, facts: `${from} wrote on ${email_.date}.${filedLine} ${step}` } }
					: { facts: { email: email_, facts: `${from} wrote on ${email_.date}. ${step}` }, suffix: filedLine }
			};
		}

		const [unread, filedCount, connections] = await Promise.all([
			this.emailModel.countDocuments({ user: uid, read: false, outgoing: false }),
			this.emailModel.countDocuments({ user: uid, "attachments.filedAs": { $ne: null, $exists: true } }),
			this.connectionModel.find({ user: uid, status: { $ne: ConnectionStatus.DISCONNECTED } }).select("emailAddress status").lean().exec()
		]);
		if (!connections.length) {
			actions.push({ label: "Connect your email", link: "/connectors" });
			return {
				title: "Bring your housing emails into Seek",
				advice:
					"Connect Gmail or Outlook and Seek brings in emails from your landlord, housemates, deposit scheme, energy supplier and university, and files certificates and bills for you. Only housing emails are synced, and replies go out from your own address.",
				actions
			};
		}
		const broken = connections.filter(c => c.status === ConnectionStatus.ERROR);
		if (broken.length) actions.push({ label: "Reconnect your email", link: "/connectors" });
		return {
			title: unread ? `${unread} unread housing email${unread === 1 ? "" : "s"}` : "Your inbox is up to date",
			advice: `Seek reads housing emails from ${connections.map(c => c.emailAddress).join(" and ")}. ${filedCount ? `${filedCount} email${filedCount === 1 ? "" : "s"} had attachments filed into your documents or bills.` : "No attachments have been filed yet."}${broken.length ? " One mailbox needs reconnecting." : ""}`,
			actions
		};
	}

	/**
	 * Lets the model reword the advice in plain English. Every fact stays
	 * from the draft; an answer that drops an amount or date is rejected.
	 */
	private async rewrite(
		user: Viewer,
		topic: AdviceTopic,
		draft: AdviceDraft,
		question?: string
	): Promise<{ advice: string; provider: LlmProvider } | null> {
		if (!this.llm.isConfigured()) return null;
		const answer = await this.llm.complete({
			system: question
				? 'You answer a question about a UK rented home for a student renting app. Use only the facts given; keep amounts, dates, names and references exactly as written and invent none. If the facts do not answer the question, say so and suggest asking the landlord. Plain British English, second person addressed to the audience (a landlord reads about applicants as "this household", never "your household"), at most 110 words, no markdown. Protecting a deposit is the LANDLORD\'s legal duty: never tell a student tenant to protect the deposit; say the landlord must. Answer with JSON only: {"advice": string}.'
				: 'You reword housing guidance for a UK student renting app. Use only the facts given; keep every amount, date, name and reference exactly as written; add nothing new. Plain British English, second person addressed to the audience (a landlord reads about applicants as "this household", never "your household"), at most 110 words, no markdown. Protecting a deposit in an approved scheme is the LANDLORD\'s legal duty: when the audience is a student tenant, never tell the student to protect the deposit; say the landlord must, and tell the student to ask for the certificate and prescribed information. Answer with JSON only: {"advice": string}.',
			messages: [
				{
					role: "user",
					content: JSON.stringify({
						audience: this.isLandlord(user) ? "landlord" : "student tenant",
						topic,
						title: draft.title,
						...(question ? { question } : {}),
						...(draft.llm?.facts ?? { facts: draft.advice })
					})
				}
			],
			maxTokens: 400,
			responseSchema: { type: "OBJECT", properties: { advice: { type: "STRING" } }, required: ["advice"] }
		});
		if (!answer) return null;
		const parsed = extractJsonObject(answer.text) as { advice?: unknown } | null;
		const advice = typeof parsed?.advice === "string" ? parsed.advice.trim() : "";
		if (advice.length < 20 || advice.length > 1200) return null;
		if (topic === "deposit" && !this.isLandlord(user) && STUDENT_PROTECTS_DEPOSIT.test(advice)) return null;
		const sent = typeof draft.llm?.facts.facts === "string" ? draft.llm.facts.facts : draft.advice;
		const facts = /£[\d,.]+\d|\b[A-Z]{2,}-[\w-]+\b|\b\d{1,2} [A-Z][a-z]+ \d{4}\b/g;
		// A reworded card keeps every fact; an answer to a question may use only some, but invents none.
		const ok = question
			? (advice.match(facts) ?? []).every(fact => sent.includes(fact))
			: (sent.match(facts) ?? []).every(fact => advice.includes(fact));
		return ok ? { advice, provider: answer.provider } : null;
	}
}

/** Quick replies for the next turn: what the search still lacks, else the design's neighbourhood question. */
export function quickReplies(filters: SearchFilters): string[] {
	if (!filters.city && !filters.nearUniversity) return ["Bristol", "Manchester", "Leeds"];
	if (!filters.maxRent) return ["Under £600", "Under £750", "Under £900"];
	if (filters.billsIncluded === undefined) return ["Bills included", "Bills not included", "Either"];
	return ["Quiet streets", "Nightlife", "Either"];
}

const EFFICIENT_EPC = ["A", "B", "C"];
/** What the student still has to do for a criterion they fail (household size is checked at apply time). */
const TO_DO: Partial<Record<string, string>> = {
	PASSPORTS: "finish your Seek Passport",
	GUARANTOR: "add a verified guarantor",
	REFERENCES: "add a verified reference"
};

/** Pass/warn lines under a search result: budget, EPC, and the landlord's criteria for this student. */
export function listingChecks(
	listing: { rentPerPerson?: number | null; monthlyRent?: number | null; epcRating?: string | null; criteria?: ReadinessCriteria | null },
	filters: SearchFilters,
	student?: { documents?: PassportDocumentInput[] },
	now = new Date()
): { kind: "pass" | "warn"; text: string }[] {
	const checks: { kind: "pass" | "warn"; text: string }[] = [];
	if (student) {
		const failed = householdReadiness([student], 1, now, listing.criteria)
			.criteria.filter(result => !result.passed && result.key in TO_DO)
			.map(result => TO_DO[result.key]);
		checks.push(
			failed.length
				? { kind: "warn", text: `To pass the landlord's checks, ${failed.join(" and ")}` }
				: { kind: "pass", text: "Your criteria pass the landlord's checks" }
		);
	}
	const rent = listing.rentPerPerson ?? listing.monthlyRent ?? null;
	if (filters.maxRent && rent != null) {
		checks.push(
			rent <= filters.maxRent
				? { kind: "pass", text: `Within your £${filters.maxRent} budget` }
				: { kind: "warn", text: `£${Math.round(rent - filters.maxRent)} over your £${filters.maxRent} budget` }
		);
	}
	if (listing.epcRating) {
		checks.push(
			EFFICIENT_EPC.includes(listing.epcRating)
				? { kind: "pass", text: `EPC ${listing.epcRating}: efficient to heat` }
				: { kind: "warn", text: `EPC ${listing.epcRating}: heating may cost more in winter` }
		);
	}
	return checks;
}
