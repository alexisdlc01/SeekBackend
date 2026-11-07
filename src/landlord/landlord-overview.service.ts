import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { Application } from "../application/application.schema";
import { ApplicationStage, LANDLORD_OPEN_STAGES } from "../application/enums/application-stage.enum";
import { householdReadiness, ReadinessCriteria } from "../application/readiness";
import { Contract, ContractStatus } from "../contracts/contract.schema";
import { Listing } from "../listings/listings.schema";
import { Payment } from "../payments/payment.schema";
import { PaymentKind, PaymentStatus } from "../payments/payment.enums";
import { RentPlan } from "../payments/rent-plan.schema";
import { monthRange } from "../payments/payments.service";
import { Repair, RepairStatus } from "../repairs/repair.schema";
import { propertyComplianceStatus, propertyRentStatus } from "./property-rows";
import { ComplianceItem, listingCompliance, sortCompliance, tenancyCompliance } from "../tenancies/compliance";
import { Tenancy } from "../tenancies/tenancy.schema";
import { TenancyStatus } from "../tenancies/tenancy.enums";
import { PassportDocumentInput } from "../users/passport";
import { NotificationTarget, notificationTarget, NotificationTargetKind } from "../notifications/links";

export interface ActivityItem {
	kind: "PAYMENT" | "APPLICATION" | "REPAIR" | "CONTRACT";
	at: Date;
	title: string;
	link: string;
	target: NotificationTarget;
}

const RECENT_LIMIT = 8;

@Injectable()
export class LandlordOverviewService {
	constructor(
		@InjectModel(Tenancy.name) private readonly tenancyModel: Model<Tenancy>,
		@InjectModel(Listing.name) private readonly listingModel: Model<Listing>,
		@InjectModel(Payment.name) private readonly paymentModel: Model<Payment>,
		@InjectModel(RentPlan.name) private readonly planModel: Model<RentPlan>,
		@InjectModel(Application.name) private readonly applicationModel: Model<Application>,
		@InjectModel(Repair.name) private readonly repairModel: Model<Repair>,
		@InjectModel(Contract.name) private readonly contractModel: Model<Contract>
	) {}

	async overview(landlordId: string, now: Date = new Date()) {
		const landlord = new Types.ObjectId(landlordId);
		const month = monthRange(undefined, now);

		const [listings, tenancies, monthPayments, applications, holdingPaid] = await Promise.all([
			this.listingModel
				.find({ landlord, isDraft: { $ne: true } })
				.select("propertyTitle streetAddress numOfPeople monthlyRent securityDeposit holdingDeposit gasSafetyExpiry eicrExpiry epcExpiry hmoLicenceExpiry")
				.lean()
				.exec(),
			this.tenancyModel
				.find({ landlord, status: TenancyStatus.ACTIVE })
				.populate({ path: "listing", select: "propertyTitle streetAddress" })
				.lean()
				.exec(),
			this.paymentModel
				// Holding deposits are not rent.
				.find({ landlord, kind: { $ne: PaymentKind.HOLDING_DEPOSIT }, dueDate: { $gte: month.start, $lt: month.end } })
				.select("amount seekFee status tenancy remindersSent")
				.lean()
				.exec(),
			this.applicationModel
				.find({ landlord, stage: { $in: LANDLORD_OPEN_STAGES } })
				.populate({ path: "applicants", select: "documents" })
				.populate({ path: "listing", select: "numOfPeople criteria propertyTitle streetAddress" })
				.select("applicants listing stage sentAt createdAt viewingAt offerExpiresAt offerExpiredAt")
				.sort({ sentAt: 1, createdAt: 1 })
				.lean()
				.exec(),
			this.paymentModel
				.find({ landlord, kind: PaymentKind.HOLDING_DEPOSIT, status: PaymentStatus.PAID, dueDate: { $gte: month.start, $lt: month.end } })
				.select("amount")
				.lean()
				.exec()
		]);

		const rent = { collected: 0, expected: 0, late: 0, lateAmount: 0, seekFee: 0 };
		for (const payment of monthPayments) {
			rent.expected += payment.amount;
			if (payment.status === PaymentStatus.PAID) {
				rent.collected += payment.amount;
				rent.seekFee += payment.seekFee;
			}
			if (payment.status === PaymentStatus.LATE) {
				rent.late += 1;
				rent.lateAmount += payment.amount;
			}
		}
		// Older arrears still count as late even when they fell due last month.
		const olderLate = await this.paymentModel
			.find({ landlord, kind: { $ne: PaymentKind.HOLDING_DEPOSIT }, status: PaymentStatus.LATE, dueDate: { $lt: month.start } })
			.select("amount tenancy dueDate remindersSent")
			.lean()
			.exec();
		rent.late += olderLate.length;
		rent.lateAmount += olderLate.reduce((sum, payment) => sum + payment.amount, 0);

		const letListings = new Set(tenancies.map(t => ((t.listing as unknown as { _id?: Types.ObjectId })?._id ?? t.listing).toString()));
		type QueueListing = { _id: Types.ObjectId; numOfPeople?: number; criteria?: ReadinessCriteria; propertyTitle?: string; streetAddress?: string } | null;
		const readinessOf = (application: (typeof applications)[number]) => {
			const members = application.applicants as unknown as { documents?: PassportDocumentInput[] }[];
			const listing = application.listing as unknown as QueueListing;
			return householdReadiness(members, listing?.numOfPeople, now, listing?.criteria);
		};
		const ready = new Map(applications.map(application => [application._id.toString(), readinessOf(application)]));
		const qualified = applications.filter(application => ready.get(application._id.toString())!.qualified).length;

		// First come: per listing, the earliest qualified household still waiting gets the offer,
		// unless another household already holds an open one. Lapsed offers wait at the back.
		const lapsed = (application: (typeof applications)[number]) => !!application.offerExpiredAt
			|| (application.stage === ApplicationStage.OFFERED && !!application.offerExpiresAt && application.offerExpiresAt <= now);
		const byListing = new Map<string, typeof applications>();
		for (const application of applications) {
			const key = ((application.listing as unknown as QueueListing)?._id ?? application.listing).toString();
			byListing.set(key, [...(byListing.get(key) ?? []), application]);
		}
		const makeOffer = [...byListing.values()].flatMap(queue => {
			if (queue.some(application => application.stage === ApplicationStage.OFFERED && !lapsed(application))) return [];
			const waiting = queue.filter(application => ready.get(application._id.toString())!.qualified);
			const next = waiting.find(application => !lapsed(application)) ?? waiting[0];
			if (!next) return [];
			const listing = next.listing as unknown as QueueListing;
			const readiness = ready.get(next._id.toString())!;
			const title = listing?.propertyTitle ?? listing?.streetAddress ?? "your property";
			return [{
				kind: "MAKE_OFFER" as const,
				count: 1,
				title: `Make an offer for ${title}`,
				applicationId: next._id.toString(),
				listingId: listing?._id?.toString() ?? String(next.listing),
				listingTitle: title,
				members: readiness.members,
				allVerified: readiness.readyMembers === readiness.members,
				viewedAt: next.viewingAt && next.viewingAt <= now ? next.viewingAt : null,
				...notificationTarget("landlord", NotificationTargetKind.APPLICATION, next._id, { listing: listing?._id ?? next.listing })
			}];
		});

		const tenancyIds = tenancies.map(t => t._id);
		const tenantSlots = tenancies.reduce((sum, t) => sum + t.tenants.length, 0);
		const autopayOn = tenancyIds.length
			? await this.planModel.countDocuments({ tenancy: { $in: tenancyIds }, autopay: true })
			: 0;

		const compliance = sortCompliance([
			...listings.flatMap(listing => listingCompliance(listing as never, now)),
			...tenancies.flatMap(tenancy => tenancyCompliance(tenancy as never, tenancy.listing as never, now))
		]);

		const properties = await this.properties(listings, tenancies, [...monthPayments, ...olderLate], applications, compliance, month.start, now);
		const openRepairs = await this.repairModel.countDocuments({ landlord, status: RepairStatus.OPEN });
		const deadlines = compliance.filter(item => item.kind !== "DEPOSIT_NOT_YET_RECEIVED");
		const todo = [
			{
				kind: "LATE_PAYMENTS" as const,
				count: rent.late,
				title: `${rent.late} late ${rent.late === 1 ? "payment" : "payments"}`,
				remindersSent: [...monthPayments.filter(payment => payment.status === PaymentStatus.LATE), ...olderLate]
					.reduce((sum, payment) => sum + (payment.remindersSent ?? 0), 0),
				...notificationTarget("landlord", NotificationTargetKind.PAYMENTS)
			},
			{
				kind: "REPAIRS_TO_BOOK" as const,
				count: openRepairs,
				title: `${openRepairs} ${openRepairs === 1 ? "repair" : "repairs"} to book`,
				...notificationTarget("landlord", NotificationTargetKind.REPAIRS)
			},
			{
				kind: "COMPLIANCE_DUE" as const,
				count: compliance.length,
				title: `${compliance.length} compliance ${compliance.length === 1 ? "item" : "items"} due`,
				// Days until the soonest legal deadline (negative once overdue). A deposit not yet
				// received has no deadline: its dueDate is only the tenancy start.
				daysLeft: deadlines.length
					? Math.ceil((Math.min(...deadlines.map(item => new Date(item.dueDate).getTime())) - now.getTime()) / (24 * 60 * 60 * 1000))
					: null,
				...notificationTarget("landlord", NotificationTargetKind.COMPLIANCE)
			},
			...makeOffer
		].filter(item => item.count > 0);

		return {
			month: month.label,
			rentCollectedThisMonth: rent.collected,
			// Not rent: shown apart so this matches /payments/landlord `collected`.
			holdingDepositsCollectedThisMonth: holdingPaid.reduce((sum, payment) => sum + payment.amount, 0),
			rentExpectedThisMonth: rent.expected,
			latePayments: rent.late,
			lateAmount: rent.lateAmount,
			seekFeeThisMonth: rent.seekFee,
			occupancy: { let: letListings.size, total: listings.length },
			applicants: { total: applications.length, qualified },
			autopay: { on: autopayOn, total: tenantSlots },
			deposits: {
				protected: tenancies.filter(t => t.depositAmount === 0 || t.depositProtectedAt).length,
				total: tenancies.length
			},
			compliance,
			properties,
			todo,
			recentActivity: await this.recentActivity(landlord)
		};
	}

	/**
	 * One row per listing for the dashboard. `applicationsNextYear` is the
	 * number of households still in the queue (sent, viewed or offered).
	 */
	private async properties(
		listings: { _id: Types.ObjectId; propertyTitle?: string; streetAddress?: string; numOfPeople?: number }[],
		tenancies: { _id: Types.ObjectId; listing: unknown; tenants: unknown[] }[],
		payments: { tenancy: Types.ObjectId; status: PaymentStatus; amount: number; dueDate?: Date }[],
		openApplications: { listing: unknown }[],
		compliance: ComplianceItem[],
		monthStart: Date,
		now: Date
	) {
		const idOf = (value: unknown) =>
			((value as { _id?: Types.ObjectId })?._id ?? (value as Types.ObjectId))?.toString();
		const listingByTenancy = new Map(tenancies.map(t => [t._id.toString(), idOf(t.listing)]));
		const tenantsByListing = new Map<string, number>();
		for (const tenancy of tenancies) {
			const key = idOf(tenancy.listing);
			tenantsByListing.set(key, (tenantsByListing.get(key) ?? 0) + tenancy.tenants.length);
		}
		const statusesByListing = new Map<string, PaymentStatus[]>();
		const collectedByListing = new Map<string, number>();
		const arrearsByListing = new Map<string, number>();
		for (const payment of payments) {
			const key = listingByTenancy.get(payment.tenancy?.toString());
			if (!key) continue;
			if (payment.status === PaymentStatus.LATE) {
				arrearsByListing.set(key, (arrearsByListing.get(key) ?? 0) + payment.amount);
			}
			// Older late payments only add to arrears; the rest is this month's rent.
			if (payment.dueDate && payment.dueDate < monthStart) continue;
			// Rent not due yet does not count towards the status, unless it is already paid.
			if (payment.status !== PaymentStatus.PAID && payment.dueDate && payment.dueDate > now) continue;
			statusesByListing.set(key, [...(statusesByListing.get(key) ?? []), payment.status]);
			if (payment.status === PaymentStatus.PAID) {
				collectedByListing.set(key, (collectedByListing.get(key) ?? 0) + payment.amount);
			}
		}
		const severitiesByListing = new Map<string, ComplianceItem["severity"][]>();
		for (const item of compliance) {
			severitiesByListing.set(item.listing, [...(severitiesByListing.get(item.listing) ?? []), item.severity]);
		}
		const queueByListing = new Map<string, number>();
		for (const application of openApplications) {
			const key = idOf(application.listing);
			queueByListing.set(key, (queueByListing.get(key) ?? 0) + 1);
		}
		return listings.map(listing => {
			const key = listing._id.toString();
			const roomsTotal = listing.numOfPeople ?? 0;
			const roomsLet = Math.min(tenantsByListing.get(key) ?? 0, roomsTotal || Infinity);
			return {
				listingId: key,
				title: listing.propertyTitle || listing.streetAddress || "Untitled property",
				roomsLet,
				roomsTotal,
				rentStatus: propertyRentStatus(statusesByListing.get(key) ?? [], tenantsByListing.has(key)),
				rentCollected: collectedByListing.get(key) ?? 0,
				arrears: arrearsByListing.get(key) ?? 0,
				complianceStatus: propertyComplianceStatus(severitiesByListing.get(key) ?? []),
				applicationsNextYear: queueByListing.get(key) ?? 0
			};
		});
	}

	/**
	 * The landlord's listings (drafts included) with how many households
	 * applied, how many of the open ones are qualified, and how often the
	 * listing was viewed.
	 */
	async listingsWithStats(landlordId: string, now: Date = new Date()) {
		const landlord = new Types.ObjectId(landlordId);
		const [listings, applications] = await Promise.all([
			this.listingModel.find({ landlord }).select("-likedBy -registerOfTitleKey -registrationNumber").sort({ lastUpdated: -1 }).lean().exec(),
			this.applicationModel
				.find({ landlord, stage: { $ne: ApplicationStage.NOT_SENT } })
				.populate({ path: "applicants", select: "documents" })
				.select("listing stage applicants")
				.lean()
				.exec()
		]);
		const byListing = new Map<string, typeof applications>();
		for (const application of applications) {
			const key = application.listing.toString();
			byListing.set(key, [...(byListing.get(key) ?? []), application]);
		}
		return listings.map(listing => {
			const sent = byListing.get(listing._id.toString()) ?? [];
			const qualifiedCount = sent.filter(application =>
				LANDLORD_OPEN_STAGES.includes(application.stage as ApplicationStage) &&
				householdReadiness(
					application.applicants as unknown as { documents?: PassportDocumentInput[] }[],
					listing.numOfPeople,
					now,
					listing.criteria
				).qualified
			).length;
			return {
				...listing,
				views: listing.views ?? 0,
				applicationsCount: sent.length,
				qualifiedCount
			};
		});
	}

	private async recentActivity(landlord: Types.ObjectId): Promise<ActivityItem[]> {
		const [payments, applications, repairs, contracts] = await Promise.all([
			this.paymentModel
				.find({ landlord, status: PaymentStatus.PAID })
				.sort({ paidAt: -1 })
				.limit(RECENT_LIMIT)
				.populate({ path: "tenant", select: "name" })
				.lean()
				.exec(),
			this.applicationModel
				.find({ landlord, stage: { $ne: ApplicationStage.NOT_SENT } })
				.sort({ sentAt: -1, createdAt: -1 })
				.limit(RECENT_LIMIT)
				.populate({ path: "listing", select: "propertyTitle streetAddress" })
				.lean()
				.exec(),
			this.repairModel
				.find({ landlord })
				.sort({ updatedAt: -1 })
				.limit(RECENT_LIMIT)
				.lean()
				.exec(),
			this.contractModel
				.find({ landlord, status: ContractStatus.SIGNED })
				.sort({ signedAt: -1 })
				.limit(RECENT_LIMIT)
				.lean()
				.exec()
		]);

		const items: ActivityItem[] = [
			...payments.map(payment => ({
				kind: "PAYMENT" as const,
				at: payment.paidAt ?? payment.dueDate,
				title: `${(payment.tenant as unknown as { name?: string })?.name ?? "A tenant"} paid £${(payment.amount / 100).toFixed(2)}`,
				...notificationTarget("landlord", NotificationTargetKind.PAYMENTS)
			})),
			...applications.map(application => {
				const listing = application.listing as unknown as { propertyTitle?: string; streetAddress?: string } | null;
				return {
					kind: "APPLICATION" as const,
					at: application.sentAt ?? application.createdAt,
					title: `${application.applicants.length} ${application.applicants.length === 1 ? "student" : "students"} applied for ${listing?.propertyTitle ?? listing?.streetAddress ?? "a property"}`,
					...notificationTarget("landlord", NotificationTargetKind.APPLICATION, application._id, {
						listing: (application.listing as unknown as { _id?: Types.ObjectId } | null)?._id ?? null
					})
				};
			}),
			...repairs.map(repair => {
				const at = (repair as { updatedAt?: Date }).updatedAt ?? repair.createdAt ?? new Date(0);
				return {
					kind: "REPAIR" as const,
					at,
					title: `Repair ${repair.status.toLowerCase()}: ${repair.title}`,
					...notificationTarget("landlord", NotificationTargetKind.REPAIRS)
				};
			}),
			...contracts.map(contract => ({
				kind: "CONTRACT" as const,
				at: contract.signedAt ?? new Date(0),
				title: `${contract.title} signed by every tenant`,
				...notificationTarget("landlord", NotificationTargetKind.CONTRACTS, contract.tenancy)
			}))
		];
		return items
			.filter(item => item.at)
			.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
			.slice(0, RECENT_LIMIT);
	}
}
