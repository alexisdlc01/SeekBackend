import {
	BadRequestException,
	ConflictException,
	ForbiddenException,
	Injectable,
	NotFoundException
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { Tenancy, TenancyDocument } from "./tenancy.schema";
import { DocumentSource, TenancyStatus } from "./tenancy.enums";
import { Listing } from "../listings/listings.schema";
import { User } from "../users/users.schema";
import { Role } from "../auth/role.enum";
import { CreateTenancyDto } from "./dto/create-tenancy.dto";
import { DepositReceivedDto, PrescribedInfoDto, UpdateDepositDto } from "./dto/update-deposit.dto";
import { AddTenancyDocumentDto } from "./dto/add-tenancy-document.dto";
import { depositCapName, depositCapPence, listingCompliance, sortCompliance, tenancyCompliance } from "./compliance";
import { RentScheduleService } from "../payments/rent-schedule.service";
import { NotificationsService } from "../notifications/notifications.service";
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

/** When the deposit was received. Never in the future: that would push back the 30-day protection deadline. */
export function depositReceivedDate(value?: string, now: Date = new Date()): Date {
	const date = value ? new Date(value) : now;
	if (date.getTime() > now.getTime() + 5 * 60_000) {
		throw new BadRequestException("The deposit received date can't be in the future.");
	}
	return date;
}

type Viewer = Pick<User, "_id" | "role">;

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
		private readonly rentSchedule: RentScheduleService,
		private readonly notifications: NotificationsService
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
		const manual = !dto.application;

		const depositAmount = dto.depositAmount ?? 0;
		this.assertDepositWithinCap(depositAmount, dto.monthlyRent, listing.nation);
		if (dto.endDate && new Date(dto.endDate) <= new Date(dto.startDate)) {
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
			endDate: dto.endDate ? new Date(dto.endDate) : null,
			periodic: dto.periodic ?? !dto.endDate,
			monthlyRent: dto.monthlyRent,
			depositAmount,
			energyAllowance: dto.energyAllowance ?? null,
			depositScheme: dto.depositScheme ?? null,
			depositReference: dto.depositReference,
			depositReceivedAt: dto.depositReceivedAt ? depositReceivedDate(dto.depositReceivedAt) : null,
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
		const people = Math.max(1, application.applicants.length);
		const startDate = listing.availableFrom && new Date(listing.availableFrom) > new Date()
			? new Date(listing.availableFrom)
			: new Date();

		try {
			const tenancy = await this.tenancyModel.create({
				listing: listing._id,
				landlord: application.landlord ?? listing.landlord,
				tenants: application.applicants,
				application: application._id,
				startDate,
				endDate: listing.availableUntil ? new Date(listing.availableUntil) : null,
				periodic: !listing.availableUntil,
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

	async updateDeposit(id: string, dto: UpdateDepositDto, landlord: Viewer) {
		const tenancy = await this.findForLandlord(id, landlord);
		const depositAmount = dto.depositAmount ?? tenancy.depositAmount;
		const listing = await this.listingModel.findById(tenancy.listing, { nation: 1 }).lean().exec();
		this.assertDepositWithinCap(depositAmount, tenancy.monthlyRent, listing?.nation);
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
					...(dto.depositReceivedAt ? { depositReceivedAt: depositReceivedDate(dto.depositReceivedAt) } : {})
				}
			}
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
		await this.appendDocument(tenancy._id, {
			type: dto.type,
			title: dto.title.trim(),
			url: dto.url,
			key: dto.key,
			source: dto.source ?? DocumentSource.UPLOAD
		});
		return this.getDetail(id, viewer);
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

	private assertDepositWithinCap(depositPence: number, monthlyRentPence: number, nation?: Nation) {
		const cap = depositCapPence(monthlyRentPence, nation);
		if (depositPence > cap) {
			throw new BadRequestException(
				nation === Nation.SCOTLAND
					? `Rent (Scotland) Act: the deposit can be at most two months' rent (£${(cap / 100).toFixed(2)} per tenant).`
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
			.populate({ path: "pendingTenants", select: TENANT_FIELDS })
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
						: "Tenant Fees Act: reduce the deposit to at most five weeks' rent per tenant.",
					...notificationTarget("landlord", NotificationTargetKind.COMPLIANCE),
					dedupeKey: `deposit-over-cap:${tenancy._id.toString()}`
				},
				"complianceDue"
			);
		}
	}
}
