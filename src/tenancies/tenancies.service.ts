import {
	BadRequestException,
	ConflictException,
	ForbiddenException,
	Injectable,
	NotFoundException
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { ConfigService } from "@nestjs/config";
import { Contract, ContractStatus } from "../contracts/contract.schema";
import { Model, Types } from "mongoose";
import { Tenancy, TenancyDocument } from "./tenancy.schema";
import { DepositScheme, DocumentSource, InventoryStage, SCOTTISH_SCHEMES, TenancyDocumentType, TenancyStatus } from "./tenancy.enums";
import { Listing } from "../listings/listings.schema";
import { User } from "../users/users.schema";
import { Role } from "../auth/role.enum";
import { CreateTenancyDto } from "./dto/create-tenancy.dto";
import { DepositReceivedDto, PrescribedInfoDto, UpdateDepositDto } from "./dto/update-deposit.dto";
import { AddTenancyDocumentDto } from "./dto/add-tenancy-document.dto";
import { depositCapName, depositCapPence, listingCompliance, sortCompliance, tenancyCompliance } from "./compliance";
import { RentScheduleService } from "../payments/rent-schedule.service";
import { NotificationsService } from "../notifications/notifications.service";
import { Payment } from "../payments/payment.schema";
import { PaymentKind, PaymentStatus } from "../payments/payment.enums";
import { addMonths, computeFee, earlyEndRefundAmount, hasFixedTerms, startOfUtcDay } from "../payments/schedule";
import { closeStripeCharge, refundPayment } from "../payments/refund";
import { NotificationKind } from "../notifications/notification-kind.enum";
import { notificationTarget, NotificationTargetKind } from "../notifications/links";
import { isKeyOwnedBy } from "../upload/object-key";
import { Application } from "../application/application.schema";
import { ApplicationStage } from "../application/enums/application-stage.enum";
import { Nation } from "../listings/enums/nation.enum";

export const TENANCY_LISTING_FIELDS =
	"propertyTitle streetAddress cityTown postcodeZIP photos location nation billsIncluded numOfPeople bedroomsCount monthlyRent securityDeposit holdingDeposit gasSafetyExpiry eicrExpiry epcExpiry hmoLicenceExpiry licenceNumber";
const LANDLORD_FIELDS = "name email companyName profilePicUrl registrations";
const TENANT_FIELDS = "name email profilePicUrl universityDetails";
// An invite is not consent: contact details only once the student has accepted.
const PENDING_TENANT_FIELDS = "name profilePicUrl";

/** When the deposit was received. Never in the future: that would push back the 30-day protection deadline. */
export function depositReceivedDate(value?: string, now: Date = new Date()): Date {
	const date = value ? new Date(value) : now;
	if (date.getTime() > now.getTime() + 5 * 60_000) {
		throw new BadRequestException("The deposit received date can't be in the future.");
	}
	return date;
}

/** The first rent day (start date + whole months) on or after `from`. */
export function nextRentDay(startDate: Date, from: Date) {
	const anchor = startOfUtcDay(new Date(startDate));
	let months = 1;
	while (addMonths(anchor, months) < from) months += 1;
	return addMonths(anchor, months);
}

/**
 * Earliest end date (exclusive London day) a tenant's notice given `today` can ask for. England: two months,
 * ending with a rent period. Scotland: 28 days. Wales: four weeks. Northern Ireland: four weeks (periodic).
 */
export function earliestNoticeEnd(nation: Nation, startDate: Date, today: Date) {
	return nation === Nation.ENGLAND ? nextRentDay(startDate, addMonths(today, 2)) : new Date(today.getTime() + 28 * 86_400_000);
}

/**
 * The period a tenancy made from an application gets: the listing's availability, never starting in the past.
 * Refuses (409) once the availability has ended, else the tenancy would end before it starts and schedule no rent.
 * Outside Northern Ireland availableUntil is only when the landlord hopes to get the home back, never an end date.
 */
export function applicationTenancyPeriod(listing: Pick<Listing, "availableFrom" | "availableUntil" | "nation">, now = new Date()) {
	const future = listing.availableFrom && new Date(listing.availableFrom) > now ? new Date(listing.availableFrom) : null;
	const until = listing.availableUntil ? new Date(listing.availableUntil) : null;
	if (until && until <= (future ?? now)) {
		throw new ConflictException("This listing's availability has ended. The landlord needs to update its 'available until' date before the tenancy can be agreed.");
	}
	// Starting now: anchor on the London day at midnight UTC, like every other tenancy date.
	return { startDate: future ?? londonCalendarDay(now), endDate: hasFixedTerms(listing.nation) ? until : null };
}

type Viewer = Pick<User, "_id" | "role">;

/** Types only a tenant's own paperwork can carry; the rest are the landlord's word (agreement, certificates). */
export const TENANT_DOCUMENT_TYPES = new Set([TenancyDocumentType.COUNCIL_TAX_EXEMPTION, TenancyDocumentType.INVENTORY, TenancyDocumentType.OTHER]);

export type TenancyLean = Tenancy & { _id: Types.ObjectId };

function idOf(value: unknown): string {
	if (value && typeof value === "object" && "_id" in (value as object)) {
		return String((value as { _id: unknown })._id);
	}
	return String(value);
}

export function isTenancyMember(tenancy: Pick<Tenancy, "landlord" | "tenants">, userId: string) {
	return (
		idOf(tenancy.landlord) === userId ||
		(tenancy.tenants ?? []).some(tenant => idOf(tenant) === userId)
	);
}

export function isTenant(tenancy: Pick<Tenancy, "tenants">, userId: string) {
	return (tenancy.tenants ?? []).some(tenant => idOf(tenant) === userId);
}

@Injectable()
export class TenanciesService {
	constructor(
		@InjectModel(Tenancy.name) private readonly tenancyModel: Model<Tenancy>,
		@InjectModel(Listing.name) private readonly listingModel: Model<Listing>,
		@InjectModel(User.name) private readonly userModel: Model<User>,
		@InjectModel(Application.name) private readonly applicationModel: Model<Application>,
		@InjectModel(Contract.name) private readonly contractModel: Model<Contract>,
		private readonly rentSchedule: RentScheduleService,
		private readonly notifications: NotificationsService,
		@InjectModel(Payment.name) private readonly paymentModel: Model<Payment>,
		private readonly config: ConfigService
	) {}

	/** Loads a tenancy the viewer belongs to (landlord, tenant or Seek staff). */
	async findForMember(id: string, viewer: Viewer): Promise<TenancyLean> {
		const tenancy = await this.findRaw(id);
		if (viewer.role !== Role.SUPERUSER && !isTenancyMember(tenancy, viewer._id.toString())) {
			throw new ForbiddenException("You are not part of this tenancy.");
		}
		return tenancy;
	}

	async findForLandlord(id: string, viewer: Viewer): Promise<TenancyLean> {
		const tenancy = await this.findRaw(id);
		if (tenancy.landlord.toString() !== viewer._id.toString()) {
			throw new ForbiddenException("Only the landlord of this tenancy can do that.");
		}
		return tenancy;
	}

	async findForTenant(id: string, viewer: Viewer): Promise<TenancyLean> {
		const tenancy = await this.findRaw(id);
		if (!isTenant(tenancy, viewer._id.toString())) {
			throw new ForbiddenException("Only a tenant of this tenancy can do that.");
		}
		return tenancy;
	}

	/** Tenancies the student lives in, plus ones they are invited to and have not accepted yet. */
	async listMine(userId: string) {
		const id = new Types.ObjectId(userId);
		return this.populated({ $or: [{ tenants: id }, { pendingTenants: id }] });
	}

	async listForLandlord(userId: string) {
		return this.populated({ landlord: new Types.ObjectId(userId) });
	}

	async getDetail(id: string, viewer: Viewer) {
		const raw = await this.findRaw(id);
		const invited = (raw.pendingTenants ?? []).some(tenant => idOf(tenant) === viewer._id.toString());
		if (!invited) await this.findForMember(id, viewer);
		const [tenancy] = await this.populated({ _id: new Types.ObjectId(id) });
		return tenancy;
	}

	async create(dto: CreateTenancyDto, landlord: Viewer) {
		const listing = await this.listingModel.findById(dto.listing).lean().exec();
		if (!listing) throw new NotFoundException("Listing not found.");
		if (listing.landlord.toString() !== landlord._id.toString()) {
			throw new ForbiddenException("You can only create tenancies for your own listings.");
		}

		// From an application, the tenants are its applicants: never a list the client sends.
		let tenantIds: string[];
		if (dto.application) {
			const application = await this.applicationModel.findById(dto.application).lean().exec();
			if (!application) throw new NotFoundException("Application not found.");
			const appListing = await this.listingModel.findById(application.listing, { landlord: 1 }).lean().exec();
			if (!appListing || appListing.landlord.toString() !== landlord._id.toString()) {
				throw new ForbiddenException("You can only create tenancies from applications to your own listings.");
			}
			if (application.listing.toString() !== listing._id.toString()) {
				throw new BadRequestException("This application is for a different listing.");
			}
			if (application.stage !== ApplicationStage.ACCEPTED) {
				throw new BadRequestException("Only an accepted application can become a tenancy.");
			}
			if (await this.tenancyModel.exists({ application: application._id })) {
				throw new ConflictException("This application already has a tenancy.");
			}
			tenantIds = [...new Set(application.applicants.map(id => id.toString()))];
		} else {
			tenantIds = [...new Set(dto.tenants ?? [])];
			if (tenantIds.length === 0) {
				throw new BadRequestException("Invite at least one student, or create the tenancy from an application.");
			}
		}
		const students = await this.userModel.countDocuments({
			_id: { $in: tenantIds.map(id => new Types.ObjectId(id)) },
			role: Role.STUDENT
		});
		if (students !== tenantIds.length) {
			throw new BadRequestException("Every tenant must be a Seek student account.");
		}
		// Outside Northern Ireland a date picked in advance can't end the tenancy, so it is not kept.
		const fixedTerm = hasFixedTerms(listing.nation);
		const endDate = fixedTerm && dto.endDate ? new Date(dto.endDate) : null;
		await this.assertNoCurrentTenancy(tenantIds, { startDate: new Date(dto.startDate), endDate });
		const manual = !dto.application;

		const depositAmount = dto.depositAmount ?? 0;
		this.assertDepositWithinCap(depositAmount, dto.monthlyRent, listing.nation);
		this.assertSchemeForNation(dto.depositScheme, listing.nation);
		if (endDate && endDate <= new Date(dto.startDate)) {
			throw new BadRequestException("The end date must be after the start date.");
		}

		const tenancy = await this.tenancyModel.create({
			listing: listing._id,
			landlord: landlord._id,
			// A hand-made tenancy only invites: students join (and rent is scheduled) when they accept.
			tenants: manual ? [] : tenantIds.map(id => new Types.ObjectId(id)),
			pendingTenants: manual ? tenantIds.map(id => new Types.ObjectId(id)) : [],
			status: manual ? TenancyStatus.PENDING_ACCEPTANCE : TenancyStatus.ACTIVE,
			application: dto.application ? new Types.ObjectId(dto.application) : null,
			startDate: new Date(dto.startDate),
			endDate,
			periodic: fixedTerm ? dto.periodic ?? !endDate : true,
			monthlyRent: dto.monthlyRent,
			depositAmount,
			energyAllowance: dto.energyAllowance ?? null,
			depositScheme: dto.depositScheme ?? null,
			depositReference: dto.depositReference,
			depositReceivedAt: dto.depositReceivedAt ? depositReceivedDate(dto.depositReceivedAt) : null,
			bankTransferInstructions: dto.bankTransferInstructions?.trim(),
			depositProtectedAt: dto.depositProtectedAt
				? new Date(dto.depositProtectedAt)
				: dto.depositScheme && dto.depositReference
					? new Date()
					: null
		});
		if (manual) {
			await this.notifyInvited(tenancy.toObject() as TenancyLean, listing);
		} else {
			await this.afterCreate(tenancy.toObject() as TenancyLean, listing);
		}
		return this.getDetail(tenancy._id.toString(), landlord);
	}

	/**
	 * An invited student accepts a hand-made tenancy. When the last one accepts
	 * the tenancy becomes ACTIVE and rent is scheduled for everyone.
	 */
	async accept(id: string, student: Viewer) {
		const tenancy = await this.findRaw(id);
		const studentId = new Types.ObjectId(student._id.toString());
		if (isTenant(tenancy, studentId.toString())) return this.getDetail(id, student);
		if (!(tenancy.pendingTenants ?? []).some(tenant => idOf(tenant) === studentId.toString())) {
			throw new ForbiddenException("You have not been invited to this tenancy.");
		}
		await this.assertNoCurrentTenancy([studentId], tenancy, tenancy._id);
		await this.tenancyModel.updateOne(
			{ _id: tenancy._id, pendingTenants: studentId },
			{ $pull: { pendingTenants: studentId }, $addToSet: { tenants: studentId } }
		);
		// Only the request that empties the invite list activates the tenancy.
		const activated = await this.tenancyModel
			.findOneAndUpdate(
				{ _id: tenancy._id, status: TenancyStatus.PENDING_ACCEPTANCE, pendingTenants: { $size: 0 } },
				{ $set: { status: TenancyStatus.ACTIVE } },
				{ new: true }
			)
			.lean()
			.exec();
		if (activated) {
			const listing = await this.listingModel.findById(activated.listing).lean().exec();
			if (listing) await this.afterCreate(activated as TenancyLean, listing);
			// The contract can only be sent once the tenancy is ACTIVE: tell the landlord it is.
			await this.notifications.notify({
				user: activated.landlord,
				kind: NotificationKind.TENANCY_CREATED,
				title: `Every tenant accepted ${listing?.propertyTitle || listing?.streetAddress || "your tenancy"}`,
				body: "The tenancy is active. You can now send the contract.",
				...notificationTarget("landlord", NotificationTargetKind.TENANCY, activated._id),
				dedupeKey: `tenancy-active:${activated._id.toString()}`
			});
		}
		return this.getDetail(id, student);
	}

	/**
	 * Turns an approved application into a tenancy. Each member pays an equal
	 * share of the listing's whole-property rent and deposit. Idempotent.
	 */
	async createFromApplication(application: {
		_id: Types.ObjectId;
		listing: Types.ObjectId;
		landlord: Types.ObjectId;
		applicants: Types.ObjectId[];
	}): Promise<TenancyLean> {
		const existing = await this.tenancyModel
			.findOne({ application: application._id })
			.lean()
			.exec();
		if (existing) return existing as TenancyLean;

		const listing = await this.listingModel.findById(application.listing).lean().exec();
		if (!listing) throw new NotFoundException("Listing not found.");
		const { startDate, endDate } = applicationTenancyPeriod(listing);
		try {
			await this.assertNoCurrentTenancy(application.applicants, { startDate, endDate });
		} catch (error) {
			// A concurrent call (double tap, two housemates) created this application's tenancy since the lookup above: that is the clash.
			const winner = error instanceof ConflictException
				? await this.tenancyModel.findOne({ application: application._id }).lean().exec()
				: null;
			if (winner) return winner as TenancyLean;
			throw error;
		}
		const people =Math.max(1, application.applicants.length);

		try {
			const tenancy = await this.tenancyModel.create({
				listing: listing._id,
				landlord: application.landlord ?? listing.landlord,
				tenants: application.applicants,
				application: application._id,
				startDate,
				endDate,
				periodic: !endDate,
				// Listings store whole-property pounds; tenancies store pence per tenant.
				monthlyRent: Math.round(((listing.monthlyRent ?? 0) * 100) / people),
				depositAmount: Math.round(((listing.securityDeposit ?? 0) * 100) / people)
			});
			const value = tenancy.toObject() as TenancyLean;
			await this.afterCreate(value, listing);
			return value;
		} catch (error) {
			if ((error as { code?: number })?.code === 11000) {
				const winner = await this.tenancyModel
					.findOne({ application: application._id })
					.lean()
					.exec();
				if (winner) return winner as TenancyLean;
			}
			throw error;
		}
	}

	/**
	 * Seek allows one tenancy at a time: a student can't be a tenant of two ACTIVE or
	 * PENDING_ACCEPTANCE tenancies whose [startDate, endDate) overlap (no endDate = open-ended).
	 * Next year's home, starting on or after this one ends, is fine. An invite alone doesn't count.
	 * `when` is the new tenancy's period, or the listing an application tenancy will let
	 * (period derived as in createFromApplication); unknown listing = any current tenancy blocks.
	 * shortcut: check-then-write, so two accepts landing in the same few ms can still both pass;
	 * upgrade to a Mongo transaction (needs a replica set) if double bookings show up.
	 */
	async assertNoCurrentTenancy(
		studentIds: Array<Types.ObjectId | string>,
		when: { startDate: Date; endDate?: Date | null } | Types.ObjectId | null | undefined,
		exceptTenancy?: Types.ObjectId
	) {
		if (studentIds.length === 0) return;
		let period = when instanceof Types.ObjectId ? undefined : when;
		if (when instanceof Types.ObjectId) {
			const listing = await this.listingModel.findById(when, { availableFrom: 1, availableUntil: 1, nation: 1 }).lean().exec();
			if (listing) period = applicationTenancyPeriod(listing);
		}
		const clash = await this.tenancyModel.exists({
			tenants: { $in: studentIds.map(id => new Types.ObjectId(id.toString())) },
			status: { $in: [TenancyStatus.ACTIVE, TenancyStatus.PENDING_ACCEPTANCE] },
			...(exceptTenancy ? { _id: { $ne: exceptTenancy } } : {}),
			...(period
				? {
					...(period.endDate ? { startDate: { $lt: period.endDate } } : {}),
					$or: [{ endDate: null }, { endDate: { $gt: period.startDate } }]
				}
				: {})
		});
		if (clash) {
			throw new ConflictException(
				`${studentIds.length === 1 ? "This student" : "A student in this household"} already has a tenancy for these dates. Seek allows one tenancy at a time.`
			);
		}
	}

	async updateDeposit(id: string, dto: UpdateDepositDto, landlord: Viewer) {
		const tenancy = await this.findForLandlord(id, landlord);
		const depositAmount = dto.depositAmount ?? tenancy.depositAmount;
		// Seek's agreement prints the amount live, so changing it once anyone signed would rewrite what they signed.
		if (
			depositAmount !== tenancy.depositAmount &&
			(await this.contractModel.exists({
				tenancy: tenancy._id,
				templateKind: { $exists: true, $ne: null },
				$or: [{ status: ContractStatus.SIGNED }, { "signatures.0": { $exists: true } }]
			}))
		) {
			throw new ConflictException("A tenant has already signed the agreement, so the deposit amount can no longer change.");
		}
		const listing = await this.listingModel.findById(tenancy.listing, { nation: 1 }).lean().exec();
		this.assertDepositWithinCap(depositAmount, tenancy.monthlyRent, listing?.nation);
		this.assertSchemeForNation(dto.depositScheme, listing?.nation);
		await this.tenancyModel.updateOne(
			{ _id: tenancy._id },
			{
				$set: {
					depositScheme: dto.depositScheme,
					depositReference: dto.depositReference.trim(),
					depositProtectedAt: dto.depositProtectedAt
						? new Date(dto.depositProtectedAt)
						: new Date(),
					depositAmount,
					...(dto.energyAllowance !== undefined ? { energyAllowance: dto.energyAllowance } : {}),
					...(dto.depositReceivedAt ? { depositReceivedAt: depositReceivedDate(dto.depositReceivedAt) } : {})
				}
			}
		);
		return this.getDetail(id, landlord);
	}

	async updateEnergyAllowance(id: string, energyAllowance: number | null, landlord: Viewer) {
		const tenancy = await this.findForLandlord(id, landlord);
		await this.tenancyModel.updateOne({ _id: tenancy._id }, { $set: { energyAllowance } });
		return this.getDetail(id, landlord);
	}

	async updateBankTransferInstructions(id: string, bankTransferInstructions: string, landlord: Viewer) {
		const tenancy = await this.findForLandlord(id, landlord);
		await this.tenancyModel.updateOne(
			{ _id: tenancy._id },
			{ $set: { bankTransferInstructions: bankTransferInstructions.trim() } }
		);
		return this.getDetail(id, landlord);
	}

	/** Starts the 30-day deposit protection clock. */
	async markDepositReceived(id: string, dto: DepositReceivedDto, landlord: Viewer) {
		const tenancy = await this.findForLandlord(id, landlord);
		await this.tenancyModel.updateOne(
			{ _id: tenancy._id },
			{ $set: { depositReceivedAt: depositReceivedDate(dto.receivedAt) } }
		);
		return this.getDetail(id, landlord);
	}

	/** Records that the tenants were given the deposit scheme's prescribed information. */
	async markPrescribedInfoSent(id: string, dto: PrescribedInfoDto, landlord: Viewer) {
		const tenancy = await this.findForLandlord(id, landlord);
		await this.tenancyModel.updateOne(
			{ _id: tenancy._id },
			{ $set: { prescribedInfoSentAt: dto.sentAt ? new Date(dto.sentAt) : new Date() } }
		);
		return this.getDetail(id, landlord);
	}

	async addDocument(id: string, dto: AddTenancyDocumentDto, viewer: Viewer) {
		const tenancy = await this.findForMember(id, viewer);
		if (dto.key && !isKeyOwnedBy(dto.key, viewer._id.toString())) {
			throw new BadRequestException("Document key was not issued to this account.");
		}
		// A housemate's "tenancy agreement" must never show as the contract: only the landlord
		// (or their team, who act as the landlord) and support file landlord documents.
		const asLandlord = viewer.role === Role.SUPERUSER || idOf(tenancy.landlord) === viewer._id.toString();
		// A housemate's file must be their own private upload: an arbitrary link shown to the landlord and housemates is a phishing vector.
		if (!asLandlord && !dto.key?.startsWith("private/")) {
			throw new BadRequestException("Upload the file first: a document needs its upload key.");
		}
		const url = asLandlord
			? dto.url
			: `https://${this.config.getOrThrow("AWS_PRIVATE_BUCKET")}.s3.${this.config.getOrThrow("AWS_S3_REGION")}.amazonaws.com/${dto.key}`;
		const type = asLandlord || TENANT_DOCUMENT_TYPES.has(dto.type) ? dto.type : TenancyDocumentType.OTHER;
		await this.appendDocument(tenancy._id, {
			type,
			title: dto.title.trim(),
			url,
			key: dto.key,
			source: dto.source ?? DocumentSource.UPLOAD,
			uploadedBy: new Types.ObjectId(viewer._id.toString()),
			uploaderRole: viewer.role,
			...(type === TenancyDocumentType.INVENTORY ? { stage: dto.stage ?? InventoryStage.CHECK_IN } : {})
		});
		return this.getDetail(id, viewer);
	}

	async confirmDocument(id: string, documentId: string, landlord: Viewer) {
		const tenancy = await this.findForLandlord(id, landlord);
		const document = (tenancy.documents ?? []).find(item => item._id?.toString() === documentId);
		if (!document || document.type !== TenancyDocumentType.TENANCY_AGREEMENT) {
			throw new NotFoundException("Tenancy agreement not found.");
		}
		await this.tenancyModel.updateOne(
			{ _id: tenancy._id, "documents._id": new Types.ObjectId(documentId) },
			{ $set: { "documents.$.confirmedByLandlord": true } }
		);
		return this.getDetail(id, landlord);
	}

	/** Ends a tenancy and returns the unused part of any paid rent period. */
	async endTenancy(id: string, endDate: Date, landlord: Viewer) {
		const tenancy = await this.findForLandlord(id, landlord);
		const end = startOfUtcDay(endDate);
		if (tenancy.status !== TenancyStatus.ACTIVE) {
			if (tenancy.status === TenancyStatus.ENDED) throw new ConflictException("This tenancy has already been ended.");
			throw new BadRequestException("Only an active tenancy can be ended.");
		}
		if (!Number.isFinite(end.getTime()) || end <= startOfUtcDay(tenancy.startDate)) {
			throw new BadRequestException("The end date must be after the tenancy start date.");
		}
		if (end < londonCalendarDay()) {
			throw new BadRequestException("The end date cannot be in the past.");
		}
		if (tenancy.endDate && end > startOfUtcDay(tenancy.endDate)) {
			throw new BadRequestException("The end date cannot be after the tenancy's current end date.");
		}

		// A future date keeps the tenants in their home until then: noticeGivenAt lets the hourly sweep end it on the date.
		const ended = await this.tenancyModel.updateOne(
			{ _id: tenancy._id, status: TenancyStatus.ACTIVE },
			{ $set: end <= londonCalendarDay() ? { endDate: end, status: TenancyStatus.ENDED } : { endDate: end, noticeGivenAt: new Date() } }
		);
		if (ended.modifiedCount === 0) {
			throw new ConflictException("This tenancy has already been ended.");
		}
		await this.stopRentAfter(tenancy, end);
		const endDay = end.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
		await this.notifications.notifyMany(
			(tenancy.tenants ?? []).map(tenant => ({
				user: tenant,
				kind: NotificationKind.TENANCY_ENDED,
				title: `Your tenancy now ends on ${endDay}`,
				body: "Rent due after that date is cancelled, and any rent you paid for days after it is refunded.",
				...notificationTarget("student", NotificationTargetKind.TENANCY, tenancy._id),
				dedupeKey: `tenancy-ended:${tenancy._id.toString()}:${end.toISOString().slice(0, 10)}`
			}))
		);
		return this.getDetail(id, landlord);
	}

	/** Removes rent due on or after `end` and refunds or reprices any rent period that runs past it. */
	private async stopRentAfter(tenancy: TenancyLean, end: Date) {
		await this.paymentModel.updateMany(
			{
				tenancy: tenancy._id,
				kind: { $ne: PaymentKind.HOLDING_DEPOSIT },
				status: PaymentStatus.PENDING,
				dueDate: { $gte: end }
			},
			[{ $set: { status: PaymentStatus.CANCELLED, refundDue: true, autoRefund: true, refundAmount: "$amount" } }]
		);
		const unpaidAfterEnd = {
			tenancy: tenancy._id,
			kind: { $ne: PaymentKind.HOLDING_DEPOSIT },
			status: { $nin: [PaymentStatus.PAID, PaymentStatus.PENDING, PaymentStatus.CANCELLED] },
			dueDate: { $gte: end }
		};
		// A Checkout session or intent the tenant opened would otherwise stay payable with no row to settle.
		const opened = await this.paymentModel
			.find({ ...unpaidAfterEnd, providerRef: /^(cs|pi)_/ }, { providerRef: 1, stripeAccountId: 1 })
			.lean()
			.exec();
		for (const payment of opened) await closeStripeCharge(process.env.STRIPE_SECRET_KEY, payment);
		await this.paymentModel.deleteMany(unpaidAfterEnd);
		const unpaidSpanning = await this.paymentModel
			.find({
				tenancy: tenancy._id,
				kind: { $ne: PaymentKind.HOLDING_DEPOSIT },
				status: { $nin: [PaymentStatus.PAID, PaymentStatus.PENDING] },
				dueDate: { $lt: end }
			})
			.lean()
			.exec();
		for (const payment of unpaidSpanning) {
			// Prorate the row's full rent, not its stored amount: an earlier shortening may have reduced it already.
			const full = Math.max(0, tenancy.monthlyRent * (payment.coversMonths ?? 1) - (payment.holdingDepositCredit ?? 0));
			const amount = full - earlyEndRefundAmount(full, new Date(payment.dueDate), payment.coversMonths ?? 1, end, tenancy.startDate);
			// Only ever lowers what is owed.
			if (amount >= payment.amount) continue;
			const repriced = await this.paymentModel.updateOne(
				{ _id: payment._id, status: { $nin: [PaymentStatus.PAID, PaymentStatus.PENDING] }, amount: payment.amount },
				{ $set: { amount, ...computeFee(amount) } }
			);
			// The open session still charges the old amount: close it so the next checkout opens one at the new amount.
			if (repriced.modifiedCount > 0) await closeStripeCharge(process.env.STRIPE_SECRET_KEY, payment);
		}

		const paidOrPending = await this.paymentModel
			.find({ tenancy: tenancy._id, kind: { $ne: PaymentKind.HOLDING_DEPOSIT }, status: { $in: [PaymentStatus.PAID, PaymentStatus.PENDING] }, refundedAt: null })
			.lean()
			.exec();
		for (const payment of paidOrPending) {
			// Refund what was paid above the new end's share of the full rent: the row may already be prorated to an earlier end.
			const full = Math.max(0, tenancy.monthlyRent * (payment.coversMonths ?? 1) - (payment.holdingDepositCredit ?? 0));
			const keep = full - earlyEndRefundAmount(full, new Date(payment.dueDate), payment.coversMonths ?? 1, end, tenancy.startDate);
			const amount = Math.max(0, payment.amount - keep);
			if (amount === 0) continue;
			const claimed = await this.paymentModel
				.findOneAndUpdate(
					{
						_id: payment._id,
						refundedAt: null,
						refundDue: { $ne: true },
						autoRefund: { $ne: true },
						refundAmount: { $in: [0, null] },
						refundedAmount: { $in: [0, null] },
						refundRef: null
					},
					{ $set: { refundDue: true, autoRefund: true, refundAmount: amount } },
					{ new: true }
				)
				.lean()
				.exec();
			// An earlier shortening already claimed a smaller refund: raise it while no Stripe refund exists yet.
			// shortcut: a refund already issued is not topped up (refundPayment refunds a payment once), refund the difference by hand.
			const raised = claimed ?? await this.paymentModel
				.findOneAndUpdate(
					{
						_id: payment._id,
						refundedAt: null,
						refundDue: true,
						autoRefund: true,
						refundFailed: { $ne: true },
						refundAmount: { $lt: amount },
						refundedAmount: { $in: [0, null] },
						refundRef: null
					},
					{ $set: { refundAmount: amount } },
					{ new: true }
				)
				.lean()
				.exec();
			if (raised?.status === PaymentStatus.PAID) {
				await refundPayment(this.paymentModel, raised, process.env.STRIPE_SECRET_KEY, raised.refundAmount);
			}
		}
	}

	/**
	 * A tenant gives notice to end a rolling tenancy. Joint tenants must all give it for the same date: the
	 * first one sets it, the others confirm. Once the last one has, it takes effect: endDate is set, rent
	 * stops there and the landlord is told. The hourly sweep then ends the tenancy on that date.
	 */
	async giveNotice(id: string, end: Date, student: Viewer) {
		const tenancy = await this.findRaw(id);
		const me = new Types.ObjectId(student._id.toString());
		if (!isTenant(tenancy, me.toString())) throw new ForbiddenException("Only a tenant of this tenancy can give notice.");
		const listing = await this.listingModel.findById(tenancy.listing, { nation: 1, propertyTitle: 1, streetAddress: 1 }).lean().exec();
		const nation = listing?.nation ?? Nation.ENGLAND;
		if (tenancy.status !== TenancyStatus.ACTIVE || (!tenancy.periodic && hasFixedTerms(nation))) {
			throw new ConflictException("Notice can only be given on an active rolling tenancy.");
		}
		if (tenancy.noticeGivenAt) throw new ConflictException("Notice has already been given on this tenancy.");
		const day = (date: Date) => date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
		const earliest = earliestNoticeEnd(nation, tenancy.startDate, londonCalendarDay());
		// A housemate's date that no longer leaves the full notice period has lapsed: this notice replaces it.
		const proposed = tenancy.noticeEndDate && new Date(tenancy.noticeEndDate) >= earliest ? new Date(tenancy.noticeEndDate) : null;
		if (proposed && (tenancy.noticeFrom ?? []).some(from => from.equals(me))) {
			throw new ConflictException("You have already given notice. It takes effect once every housemate has given it too.");
		}
		if (end < earliest) throw new BadRequestException(`That is too soon: the earliest end date you can give notice for is ${day(earliest)}.`);
		if (nation === Nation.ENGLAND && nextRentDay(tenancy.startDate, end).getTime() !== end.getTime()) {
			throw new BadRequestException(`In England notice must end with a rent period: pick a rent day, such as ${day(earliest)}.`);
		}
		if (proposed && proposed.getTime() !== end.getTime()) {
			throw new ConflictException(`A housemate has given notice to end on ${day(proposed)}. Joint tenants must all give notice for the same date.`);
		}
		const signed = await this.tenancyModel
			.findOneAndUpdate(
				{ _id: tenancy._id, status: TenancyStatus.ACTIVE, noticeGivenAt: null, noticeEndDate: tenancy.noticeEndDate ?? null },
				proposed ? { $addToSet: { noticeFrom: me } } : { $set: { noticeEndDate: end, noticeFrom: [me], noticeGivenBy: me } },
				{ new: true }
			)
			.lean()
			.exec();
		if (!signed) throw new ConflictException("The notice changed in the meantime. Reload and try again.");
		if (!(signed.tenants ?? []).every(tenant => (signed.noticeFrom ?? []).some(from => from.equals(tenant)))) return this.getDetail(id, student);

		const effective = await this.tenancyModel
			.findOneAndUpdate(
				{ _id: tenancy._id, status: TenancyStatus.ACTIVE, noticeGivenAt: null, noticeEndDate: end },
				{ $set: { endDate: end, noticeGivenAt: new Date() } },
				{ new: true }
			)
			.lean()
			.exec();
		if (effective) {
			await this.stopRentAfter(effective as TenancyLean, end);
			await this.notifications.notify({
				user: effective.landlord,
				kind: NotificationKind.TENANCY_ENDED,
				title: `Your tenants at ${listing?.propertyTitle || listing?.streetAddress || "your property"} gave notice`,
				body: `The tenancy ends on ${day(end)}. Rent after that date is cancelled.`,
				...notificationTarget("landlord", NotificationTargetKind.TENANCY, effective._id),
				dedupeKey: `tenancy-notice:${effective._id.toString()}`
			});
		}
		return this.getDetail(id, student);
	}

	async appendDocument(
		tenancyId: Types.ObjectId | string,
		document: Omit<TenancyDocument, "addedAt" | "_id">
	) {
		await this.tenancyModel.updateOne(
			{ _id: tenancyId },
			{ $push: { documents: { ...document, addedAt: new Date() } } }
		);
	}

	/** Compliance items for a tenancy and the listing it lets. */
	complianceFor(tenancy: TenancyLean, listing: Record<string, unknown> | undefined, now = new Date()) {
		const listingLike = listing as Parameters<typeof listingCompliance>[0] | undefined;
		return sortCompliance([
			...(listingLike ? listingCompliance(listingLike, now) : []),
			// A pending tenancy already needs its deposit receipt recorded; only an ended one has nothing left to do.
			...(tenancy.status !== TenancyStatus.ENDED ? tenancyCompliance(tenancy, listingLike, now) : [])
		]);
	}

	/** A Scottish home's deposit must sit in a Scottish scheme, and only there; an unknown nation accepts any. */
	private assertSchemeForNation(scheme?: DepositScheme | null, nation?: Nation) {
		if (!scheme || !nation) return;
		if (SCOTTISH_SCHEMES.includes(scheme) !== (nation === Nation.SCOTLAND)) {
			throw new BadRequestException(
				nation === Nation.SCOTLAND
					? "A home in Scotland must protect the deposit with SafeDeposits Scotland, Letting Protection Service Scotland or mydeposits Scotland."
					: "This deposit scheme only covers homes in Scotland. Choose DPS, TDS or mydeposits."
			);
		}
	}

	private assertDepositWithinCap(depositPence: number, monthlyRentPence: number, nation?: Nation) {
		const cap = depositCapPence(monthlyRentPence, nation);
		if (depositPence > cap) {
			throw new BadRequestException(
				nation === Nation.SCOTLAND
					? `Rent (Scotland) Act: the deposit can be at most two months' rent (£${(cap / 100).toFixed(2)} per tenant).`
					: nation === Nation.NORTHERN_IRELAND
						? `Private Tenancies Act (NI): the deposit can be at most one month's rent (£${(cap / 100).toFixed(2)} per tenant).`
						: `Tenant Fees Act: the deposit can be at most five weeks' rent (£${(cap / 100).toFixed(2)} per tenant).`
			);
		}
	}

	private async findRaw(id: string): Promise<TenancyLean> {
		if (!Types.ObjectId.isValid(id)) throw new BadRequestException("Invalid tenancy id.");
		const tenancy = await this.tenancyModel.findById(id).lean().exec();
		if (!tenancy) throw new NotFoundException("Tenancy not found.");
		return tenancy as TenancyLean;
	}

	private async populated(filter: Record<string, unknown>) {
		const tenancies = await this.tenancyModel
			.find(filter)
			.populate({ path: "listing", select: TENANCY_LISTING_FIELDS })
			.populate({ path: "landlord", select: LANDLORD_FIELDS })
			.populate({ path: "tenants", select: TENANT_FIELDS })
			.populate({ path: "pendingTenants", select: PENDING_TENANT_FIELDS })
			.sort({ status: 1, startDate: -1 })
			.lean()
			.exec();
		const now = new Date();
		return tenancies.map(tenancy => ({
			...tenancy,
			compliance: this.complianceFor(
				tenancy as unknown as TenancyLean,
				tenancy.listing as unknown as Record<string, unknown>,
				now
			)
		}));
	}

	private async notifyInvited(tenancy: TenancyLean, listing: Listing) {
		const title = listing.propertyTitle || listing.streetAddress || "a new home";
		await this.notifications.notifyMany(
			(tenancy.pendingTenants ?? []).map(tenant => ({
				user: tenant,
				kind: NotificationKind.TENANCY_INVITE,
				title: `You've been invited to a tenancy at ${title}`,
				body: "Check the details and accept it. Rent starts once every housemate has accepted.",
				...notificationTarget("student", NotificationTargetKind.TENANCY, tenancy._id),
				dedupeKey: `tenancy-invite:${tenancy._id.toString()}:${tenant.toString()}`
			}))
		);
	}

	private async afterCreate(tenancy: TenancyLean, listing: Listing) {
		await this.rentSchedule.ensureDefaultPlans(tenancy);
		const title = listing.propertyTitle || listing.streetAddress || "your new home";
		await this.notifications.notifyMany(
			tenancy.tenants.map(tenant => ({
				user: tenant,
				kind: NotificationKind.TENANCY_CREATED,
				title: `Your tenancy at ${title} is set up`,
				body: "Rent, bills and documents for the house now live in Seek.",
				...notificationTarget("student", NotificationTargetKind.TENANCY, tenancy._id),
				dedupeKey: `tenancy:${tenancy._id.toString()}`
			}))
		);
		// A warning for the landlord, never a block: the tenancy exists either way.
		const overCap = depositCapPence(tenancy.monthlyRent, listing.nation) < tenancy.depositAmount;
		if (overCap) {
			await this.notifications.notify(
				{
					user: tenancy.landlord,
					kind: NotificationKind.COMPLIANCE_DUE,
					title: `${title}: the deposit is above the ${depositCapName(listing.nation)}`,
					body: listing.nation === Nation.SCOTLAND
						? "Rent (Scotland) Act: reduce the deposit to at most two months' rent per tenant."
						: listing.nation === Nation.NORTHERN_IRELAND
							? "Private Tenancies Act (NI): reduce the deposit to at most one month's rent per tenant."
							: "Tenant Fees Act: reduce the deposit to at most five weeks' rent per tenant.",
					...notificationTarget("landlord", NotificationTargetKind.COMPLIANCE),
					dedupeKey: `deposit-over-cap:${tenancy._id.toString()}`
				},
				"complianceDue"
			);
		}
	}
}

/** The London calendar day containing an instant, represented as a UTC calendar date. */
export function londonCalendarDay(value: Date = new Date()): Date {
	const parts = new Intl.DateTimeFormat("en-GB", {
		timeZone: "Europe/London",
		year: "numeric",
		month: "2-digit",
		day: "2-digit"
	}).formatToParts(value);
	const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(item => item.type === type)?.value);
	return new Date(Date.UTC(part("year"), part("month") - 1, part("day")));
}
