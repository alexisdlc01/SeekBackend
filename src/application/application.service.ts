import {
	BadRequestException,
	ConflictException,
	ForbiddenException,
	Injectable,
	NotFoundException
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { HydratedDocument, Model, Types } from "mongoose";
import { Application } from "./application.schema";
import { ListingsService } from "../listings/listings.service";
import { User } from "../users/users.schema";
import { ApplicationStage, LANDLORD_OPEN_STAGES } from "./enums/application-stage.enum";
import { Conversation } from "../conversation/converstaion.schema";
import { UsersRepository } from "../users/users.repository";
import { ApplicationDto } from "./dto/application.dto";
import { plainToInstance } from "class-transformer";
import { ConversationAccessService } from "../conversation/conversation-access.service";
import { generateToken, hashToken, tokensMatch } from "../shared/tokens";
import { DocumentSharesService } from "../users/shares/document-shares.service";
import { TenanciesService } from "../tenancies/tenancies.service";
import { NotificationsService } from "../notifications/notifications.service";
import { NotificationKind } from "../notifications/notification-kind.enum";
import { notificationTarget, NotificationTargetKind } from "../notifications/links";
import { buildPassport, PassportDocumentInput, StudentEmailProof, withoutFiles } from "../users/passport";
import { compareForLandlord, householdReadiness, ReadinessCriteria } from "./readiness";
import { parseUniversityDetails } from "./university-details";
import { OFFER_WINDOW_DAYS } from "./offer";
import { missingDocuments } from "./required-documents";
import { Payment } from "../payments/payment.schema";
import { PaymentKind, PaymentStatus } from "../payments/payment.enums";
import { StripeApiError, StripeClient } from "../payments/stripe";

/** How long a shared invite link stays usable. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class ApplicationService {
	constructor(
		@InjectModel(Application.name)
		private readonly applicationModel: Model<Application>,
		@InjectModel(Conversation.name)
		private readonly converstaionModel: Model<Conversation>,
		private readonly listingService: ListingsService,
		private readonly userSevice: UsersRepository,
		private readonly conversationAccessService: ConversationAccessService,
		private readonly sharesService: DocumentSharesService,
		private readonly tenanciesService: TenanciesService,
		private readonly notificationsService: NotificationsService,
		@InjectModel(Payment.name)
		private readonly paymentModel: Model<Payment>,
	) { }

	async create(
		listingId: string,
		user: User
	): Promise<ApplicationDto> {
		if (!Types.ObjectId.isValid(listingId)) {
			throw new BadRequestException("Invalid listing ID");
		}

		const listing = await this.listingService.findPublishedListingById(listingId);

		const applicationKey = `${listing._id.toString()}:${user._id.toString()}`;
		const existingApplication = await this.applicationModel
			.findOne({
				$or: [
					{ applicationKey },
					{ listing: listing._id, owner: user._id },
				]
			})
			.exec();
		if (existingApplication) {
			// The household's own accepted application is excluded, so it still gets it back.
			await this.assertNotLet(existingApplication);
			return this.toDto(existingApplication);
		}

		await this.assertNotLet({ listing: listing._id });
		const missing = missingDocuments(listing, (user.documents ?? []).map(document => document.type));
		if (missing.length > 0) {
			throw new BadRequestException(`Missing required documents: ${missing.join(", ")}. Add them to your Seek Passport, then apply.`);
		}

		const conversation = await this.converstaionModel.create({
			name: `${user.name}'s application to ${listing.propertyTitle}`,
			createdBy: user._id,
			users: [user._id]
		});

		try {
			const application = await this.applicationModel.create({
				listing: listing._id,
				landlord: listing.landlord,
				applicants: [user._id],
				conversation: conversation._id,
				owner: user._id,
				applicationKey,
			});
			return this.toDto(application);
		} catch (error) {
			// If two requests raced, the unique application key chooses the winner.
			// Remove only this request's unused conversation and return the winner.
			if (this.isDuplicateKeyError(error)) {
				await this.converstaionModel.deleteOne({ _id: conversation._id });
				const existing = await this.applicationModel
					.findOne({ applicationKey })
					.exec();
				if (existing) return this.toDto(existing);
			}

			await this.converstaionModel.deleteOne({ _id: conversation._id });
			throw error;
		}
	}

	async changeOwner(
		applicationId: string,
		newOwner: string
	): Promise<void> {
		const user = await this.userSevice.getUserById(newOwner);
		if (!user) {
			throw new NotFoundException("no such user exists for transfer.");
		}

		const result = await this.applicationModel.updateOne({
			_id: applicationId
		}, {
			owner: newOwner
		}).exec();
		if (result.modifiedCount === 0) {
			throw new NotFoundException("no such user exists for the transfer.");
		}
	}

	async delete(
		applicationId: string,
	): Promise<void> {
		if (Types.ObjectId.isValid(applicationId)) await this.sharesService.revokeForApplication(applicationId);
		await this.applicationModel.deleteOne({
			_id: applicationId
		});
	}

	async getAllMyApplications(userId: string): Promise<ApplicationDto[]> {
		const applications = await this.applicationModel
			.find({ applicants: userId })
			.populate({
				path: "listing",
				select: "-registerOfTitleKey -registrationNumber -likedBy",
			})
			.populate({
				path: "conversation",
				populate: {
					path: "lastMessage",
				}
			})
			.sort({ createdAt: -1 })
			.exec() ?? [];
		// Hide legacy duplicates from the client. New records are protected by the
		// applicationKey unique index, so this only affects pre-existing data.
		const seenListings = new Set<string>();
		const unique = applications.filter(application => {
			const listing = application.listing as any;
			const listingId = listing?._id?.toString?.() ?? listing?.toString?.();
			if (!listingId || seenListings.has(listingId)) return false;
			seenListings.add(listingId);
			return true;
		});
		const now = new Date();
		return Promise.all(unique.map(async application => {
			const listingId = (application.listing as unknown as { _id: Types.ObjectId })._id;
			// The household's own readiness comes from its own row; the listing's queue is only loaded below when needed.
			const [listing, own] = await Promise.all([
				this.listingService.findListingById(listingId.toString()).catch(() => null),
				this.applicationModel
					.findById(application._id)
					.populate({ path: "applicants", select: "name documents studentVerifiedAt universityEmail" })
					.lean()
					.exec(),
			]);
			const mine = own ? this.householdEntry(own, listing, now) : undefined;
			// Only a qualified open household holds a place in line, so only then load the listing's queue.
			const qualified = mine?.qualified && LANDLORD_OPEN_STAGES.includes(application.stage as ApplicationStage)
				? (await this.queueFor(listingId, now)).qualified
				: [];
			const index = qualified.findIndex(entry => entry.id === application._id.toString());
			const viewingSlotAvailability = listing
				? await this.listingService.viewingSlotAvailability(listing)
				: [];
			const dto = this.toDto(application, {
				qualified: mine?.qualified ?? false,
				readiness: mine?.readiness,
				criteria: mine?.criteria,
				members: mine?.members,
				queuePosition: index >= 0 ? index + 1 : null,
				queueSize: qualified.length,
			});
			if (dto.listing) dto.listing.viewingSlotAvailability = viewingSlotAvailability;
			return dto;
		}));
	}

	/**
	 * A listing's queue: open households (sent, viewed or offered) in the
	 * order they applied, with readiness. Only qualified ones hold a place;
	 * there is no bidding. Members carry only the document fields readiness
	 * needs (no names, labels or file links), so entries' passports are partial.
	 */
	private async queueFor(listingId: Types.ObjectId | string, now: Date) {
		const [open, listing, letTo] = await Promise.all([
			this.applicationModel
				.find({ listing: listingId, stage: { $in: LANDLORD_OPEN_STAGES } })
				.populate({ path: "applicants", select: "documents.type documents.status documents.expiresAt studentVerifiedAt" })
				.sort({ sentAt: 1, createdAt: 1 })
				.lean()
				.exec(),
			this.listingService.findListingById(listingId.toString()).catch(() => null),
			this.applicationModel.exists({ listing: listingId, stage: { $in: [ApplicationStage.ACCEPTED, ApplicationStage.SIGNED] } }),
		]);
		const all = (open ?? []).map(application => this.householdEntry(application, listing, now));
		// A let property has no queue: nobody waiting on it is in line any more.
		return { all, qualified: letTo ? [] : all.filter(entry => entry.qualified), listing };
	}

	/** One household's readiness, with passports stripped of file links. Applicants must be populated with name and documents. */
	private householdEntry<T extends { _id: Types.ObjectId; applicants: unknown }>(
		application: T,
		listing: Awaited<ReturnType<ListingsService["findListingById"]>> | null,
		now: Date,
	) {
		const members = (application.applicants as ({
			_id: Types.ObjectId;
			name?: string;
			documents?: PassportDocumentInput[];
		} & StudentEmailProof)[]).filter(member => member && typeof member === "object" && "_id" in member);
		const household = householdReadiness(members, listing?.numOfPeople, now, listing?.criteria);
		return {
			id: application._id.toString(),
			application,
			...household,
			members: members.map(member => ({
				user: member._id.toString(),
				name: member.name,
				passport: withoutFiles(buildPassport(member.documents, now, member)),
				shareExpiresAt: null,
				universityDetails: null,
			})),
		};
	}

	/**
	 * The landlord's inbox for a listing: each household with its readiness,
	 * qualified ones first, then in the order they were sent. Passport file
	 * links are only included while the member's share is active.
	 */
	async getAllByListing(listingId: string, viewerId?: string): Promise<ApplicationDto[]> {
		const applications = await this.applicationModel
			.find({
				listing: listingId,
				// Everything the household has sent, from SENT through to SIGNED.
				stage: { $ne: ApplicationStage.NOT_SENT },
			})
			.populate({ path: "applicants", select: "name email profilePicUrl documents universityDetails studentVerifiedAt universityEmail" })
			.sort({ createdAt: -1 })
			.exec() ?? [];
		if (applications.length === 0) return [];

		const listing = await this.listingService
			.findListingById(listingId)
			.catch(() => null);
		const now = new Date();
		const memberIds = applications.flatMap(application =>
			(application.applicants as unknown as { _id: Types.ObjectId }[]).map(a => a?._id ?? a)
		);
		const shares = viewerId
			? await this.sharesService.activeOwnersFor(viewerId, memberIds, now)
			: new Map<string, Date>();

		return applications
			.map(application => {
				const members = (application.applicants as unknown as ({
					_id: Types.ObjectId;
					name?: string;
					documents?: PassportDocumentInput[];
					universityDetails?: string;
				} & StudentEmailProof)[]).filter(member => member && typeof member === "object" && "_id" in member);
				const household = householdReadiness(members, listing?.numOfPeople, now, listing?.criteria);
				// Document access ends when the application closes, whatever other share is still open.
				const closed = application.stage === ApplicationStage.REJECTED;
				return this.toDto(application, {
					readiness: household.readiness,
					qualified: household.qualified,
					criteria: household.criteria,
					members: members.map(member => {
						const shareExpiresAt = closed ? null : shares.get(member._id.toString()) ?? null;
						const passport = buildPassport(member.documents, now, member);
						return {
							user: member._id.toString(),
							name: member.name,
							passport: shareExpiresAt ? passport : withoutFiles(passport),
							shareExpiresAt,
							universityDetails: parseUniversityDetails(member.universityDetails)
						};
					})
				});
			})
			.sort(compareForLandlord);
	}

	/** The landlord or a household member proposes a viewing time. */
	async scheduleViewing(applicationId: string, viewingAt: string, user: User): Promise<ApplicationDto> {
		if (!Types.ObjectId.isValid(applicationId)) {
			throw new BadRequestException("Invalid application ID");
		}
		const application = await this.applicationModel.findById(applicationId).exec();
		if (!application) {
			throw new NotFoundException("Application not found");
		}
		const userId = user._id.toString();
		const isLandlord = application.landlord?.toString() === userId;
		const isApplicant = application.applicants.some(a => a.toString() === userId);
		if (!isLandlord && !isApplicant) {
			throw new ForbiddenException("You are not part of this application");
		}
		if (![ApplicationStage.SENT, ApplicationStage.VIEWED].includes(application.stage as ApplicationStage)) {
			throw new BadRequestException("Viewings can only be booked for applications that are still open.");
		}
		const when = new Date(viewingAt);
		if (when.getTime() < Date.now() - 60 * 60 * 1000) {
			throw new BadRequestException("Pick a viewing time in the future.");
		}

		const listing = await this.listingService.findListingById(application.listing.toString());
		const slots = (listing.viewingSlots ?? []).map(slot => new Date(slot).getTime());
		// Students choose from the times the landlord offered; the landlord may
		// still move a viewing to any time that suits both sides.
		if (!isLandlord && slots.length > 0 && !slots.includes(when.getTime())) {
			throw new BadRequestException("That viewing time is not offered. Pick one of the landlord's slots.");
		}
		const capacity = Math.max(1, listing.viewingSlotCapacity ?? 1);
		const othersBooked = () => this.applicationModel.countDocuments({
			_id: { $ne: application._id },
			listing: application.listing,
			viewingAt: when,
			stage: { $in: [ApplicationStage.SENT, ApplicationStage.VIEWED, ApplicationStage.OFFERED] },
		});
		const slotFull = new BadRequestException("That slot is already booked by another household. Pick another time.");
		if (slots.length > 0 && await othersBooked() >= capacity) throw slotFull;

		const previous = { viewingAt: application.viewingAt ?? null, stage: application.stage };
		application.viewingAt = when;
		if (application.stage === ApplicationStage.SENT) {
			application.stage = ApplicationStage.VIEWED;
		}
		await application.save();
		// Check-then-write is not atomic: re-count now that ours is saved and back out if two bookings raced past capacity.
		if (slots.length > 0 && await othersBooked() >= capacity) {
			await this.applicationModel.updateOne({ _id: application._id, viewingAt: when }, { $set: previous }).exec();
			throw slotFull;
		}

		const recipients = isLandlord
			? application.applicants
			: [application.landlord, ...application.applicants.filter(a => a.toString() !== userId)];
		const label = when.toLocaleString("en-GB", {
			weekday: "short",
			day: "numeric",
			month: "short",
			hour: "2-digit",
			minute: "2-digit",
			timeZone: "Europe/London"
		});
		await this.notificationsService.notifyMany(
			recipients.map(recipient => ({
				user: recipient,
				kind: NotificationKind.VIEWING_SCHEDULED,
				title: `Viewing booked for ${label}`,
				body: `${user.name ?? "Someone"} set the viewing time.`,
				...(recipient.toString() === application.landlord?.toString()
					? notificationTarget("landlord", NotificationTargetKind.APPLICATION, application._id, { listing: application.listing })
					: notificationTarget("student", NotificationTargetKind.APPLICATION, application._id)),
				dedupeKey: `viewing:${application._id.toString()}:${when.toISOString()}`
			}))
		);
		return this.toDto(application);
	}

	/**
	 * Accepting a household creates its tenancy (idempotent on retries). Same
	 * first-come rule as an offer: only the next qualified household in line.
	 */
	async approve(applicationId: string): Promise<{ tenancy: string }> {
		const current = await this.applicationModel.findById(applicationId).exec();
		if (!current) throw new NotFoundException("Application not found");
		if (current.stage !== ApplicationStage.ACCEPTED) {
			if (!LANDLORD_OPEN_STAGES.includes(current.stage as ApplicationStage)) {
				throw new BadRequestException("Only open applications can be accepted.");
			}
			await this.assertNextInQueue(current, new Date());
			await this.tenanciesService.assertNoCurrentTenancy(current.applicants, current.listing);
		}
		const application = await this.applicationModel
			.findOneAndUpdate({
				_id: applicationId,
				stage: current.stage,
			}, {
				$set: { stage: ApplicationStage.ACCEPTED }
			}, { new: true })
			.exec();
		if (!application) {
			throw new BadRequestException("Only open applications can be accepted.");
		}
		// Approved straight from an offer: unpaid holding deposits can't be paid any more.
		if (current.stage === ApplicationStage.OFFERED) await this.dropUnpaidHoldingDeposits(application._id);
		const tenancy = await this.tenanciesService.createFromApplication(application);
		await this.closeOthers(application);
		return { tenancy: tenancy._id.toString() };
	}

	/**
	 * The landlord offers the room to a household. They get 15 days to accept,
	 * and the listing's holding deposit is recorded with the offer.
	 */
	async offer(applicationId: string): Promise<ApplicationDto> {
		const now = new Date();
		const current = await this.applicationModel.findById(applicationId).exec();
		if (!current) throw new NotFoundException("Application not found");
		const lapsed = current.stage === ApplicationStage.OFFERED
			&& !!current.offerExpiresAt && current.offerExpiresAt <= now;
		if (!LANDLORD_OPEN_STAGES.includes(current.stage as ApplicationStage) || (current.stage === ApplicationStage.OFFERED && !lapsed)) {
			throw new BadRequestException("An offer can only be made on an open application, or renewed once the last one lapsed.");
		}
		await this.assertNextInQueue(current, now);
		const listing = await this.listingService.findListingById(current.listing.toString());
		const application = await this.applicationModel
			.findOneAndUpdate({
				_id: applicationId,
				stage: current.stage,
			}, {
				$set: {
					stage: ApplicationStage.OFFERED,
					offeredAt: now,
					offerExpiredAt: null,
					offerExpiresAt: new Date(now.getTime() + OFFER_WINDOW_DAYS * 24 * 60 * 60 * 1000),
					holdingDeposit: listing.holdingDeposit ?? null,
				}
			}, { new: true })
			.exec();
		if (!application) {
			throw new BadRequestException("This application changed while you were making the offer. Try again.");
		}
		await this.createHoldingDeposits(application, listing.holdingDeposit);
		await this.notificationsService.notifyMany(
			application.applicants.map(applicant => ({
				user: applicant,
				kind: NotificationKind.OFFER_MADE,
				title: `You have an offer for ${listing.propertyTitle ?? listing.streetAddress ?? "a property"}`,
				body: `Accept within ${OFFER_WINDOW_DAYS} days to secure it.`,
				...notificationTarget("student", NotificationTargetKind.APPLICATION, application._id),
				dedupeKey: `offer:${application._id.toString()}:${application.offeredAt?.toISOString()}`
			}))
		);
		return this.toDto(application);
	}

	/**
	 * First come, no bidding: only a qualified household can get an offer, it
	 * must be the earliest qualified one still in the queue (households whose
	 * offer lapsed are skipped while anyone else waits), and only one offer can
	 * be open on a listing at a time.
	 */
	private async assertNextInQueue(current: HydratedDocument<Application>, now: Date) {
		await this.assertNotLet(current);
		const queue = await this.queueFor(current.listing, now);
		const id = current._id.toString();
		const target = queue.all.find(entry => entry.id === id);
		if (!target?.qualified) {
			throw new ConflictException("Only a qualified household can get an offer or be accepted: every member's Seek Passport must be complete and the listing's criteria met.");
		}
		const openOffer = queue.all.some(entry =>
			entry.id !== id
			&& entry.application.stage === ApplicationStage.OFFERED
			&& !!entry.application.offerExpiresAt && new Date(entry.application.offerExpiresAt) > now
		);
		if (openOffer) {
			throw new ConflictException("Another household already holds an open offer on this property. Wait until it is accepted or expires.");
		}
		const lapsed = (entry: (typeof queue.all)[number]) => !!entry.application.offerExpiredAt
			|| (entry.application.stage === ApplicationStage.OFFERED && !!entry.application.offerExpiresAt && new Date(entry.application.offerExpiresAt) <= now);
		const first = queue.qualified.find(entry => !lapsed(entry)) ?? queue.qualified[0];
		if (first.id !== id) {
			throw new ConflictException("First come, first served: only the first qualified household in this listing's queue can get an offer or be accepted.");
		}
	}

	/** `_id` is the household's own application, left out for one not created yet. */
	private async assertNotLet(application: Pick<Application, "listing"> & { _id?: Types.ObjectId }) {
		// shortcut: one let per listing; allow a later period here if re-letting is ever needed.
		const taken = await this.applicationModel.exists({
			...(application._id ? { _id: { $ne: application._id } } : {}),
			listing: application.listing,
			stage: { $in: [ApplicationStage.ACCEPTED, ApplicationStage.SIGNED] },
		});
		if (taken) {
			throw new ConflictException("Another household has already accepted this property.");
		}
	}

	/**
	 * One payable holding deposit per member (the listing's amount is per room),
	 * due when the offer lapses. A renewed offer reuses each member's unpaid
	 * row (keeping an open Checkout session when the amount is unchanged),
	 * drops any extra one, and never charges a member who already paid. Seek's
	 * fee is on rent only, so the landlord receives the whole holding deposit.
	 */
	private async createHoldingDeposits(application: HydratedDocument<Application>, pounds?: number | null) {
		const amount = Math.round(Number(pounds) * 100);
		const valid = Number.isFinite(amount) && amount > 0;
		const base = { application: application._id, kind: PaymentKind.HOLDING_DEPOSIT };
		const existing = await this.paymentModel.find(base).lean().exec();
		const paid = new Set(existing.filter(row => row.status === PaymentStatus.PAID).map(row => row.tenant.toString()));
		const members = new Set(application.applicants.map(applicant => applicant.toString()));
		const kept = new Map<string, (typeof existing)[number]>();
		// Rows with a provider reference first, so an open session is the one kept.
		for (const row of [...existing].sort((a, b) => Number(!!b.providerRef) - Number(!!a.providerRef))) {
			const tenant = row.tenant.toString();
			if (valid && row.status !== PaymentStatus.PAID && members.has(tenant) && !paid.has(tenant) && !kept.has(tenant)) kept.set(tenant, row);
		}
		const keptIds = new Set([...kept.values()].map(row => row._id.toString()));
		const stale = existing.filter(row => row.status !== PaymentStatus.PAID && !keptIds.has(row._id.toString())).map(row => row._id);
		if (stale.length > 0) await this.paymentModel.deleteMany({ _id: { $in: stale }, status: { $ne: PaymentStatus.PAID } });
		for (const row of kept.values()) {
			await this.paymentModel.updateOne(
				{ _id: row._id, status: { $ne: PaymentStatus.PAID } },
				{ $set: { amount, seekFee: 0, payout: amount, dueDate: application.offerExpiresAt, ...(row.amount === amount ? {} : { providerRef: null }) } }
			);
		}
		if (!valid) return;
		const docs = application.applicants
			.filter(applicant => !paid.has(applicant.toString()) && !kept.has(applicant.toString()))
			.map(applicant => ({
				...base,
				tenant: applicant,
				landlord: application.landlord,
				amount,
				seekFee: 0,
				payout: amount,
				dueDate: application.offerExpiresAt,
				status: PaymentStatus.SCHEDULED,
			}));
		if (docs.length > 0) await this.paymentModel.insertMany(docs);
	}

	/**
	 * Hourly: an offer nobody accepted in 15 days goes back to the queue. The
	 * household is told, unpaid holding deposits are dropped, and the landlord
	 * is pointed at the next qualified household.
	 */
	async expireOffers(now: Date = new Date()): Promise<number> {
		const lapsed = await this.applicationModel
			.find({ stage: ApplicationStage.OFFERED, offerExpiresAt: { $lte: now } })
			.exec();
		let expired = 0;
		for (const application of lapsed) {
			const reopened = await this.applicationModel.findOneAndUpdate(
				{ _id: application._id, stage: ApplicationStage.OFFERED, offerExpiresAt: application.offerExpiresAt },
				{
					$set: {
						stage: application.viewingAt ? ApplicationStage.VIEWED : ApplicationStage.SENT,
						offeredAt: null,
						offerExpiresAt: null,
						offerExpiredAt: application.offerExpiresAt,
						holdingDeposit: null,
					}
				},
				{ new: true }
			).exec();
			if (!reopened) continue;
			expired += 1;
			await this.sharesService.revokeForApplication(application._id);
			await this.dropUnpaidHoldingDeposits(application._id);
			const key = application.offerExpiresAt?.toISOString();
			const queue = await this.queueFor(application.listing, now);
			const title = queue.listing?.propertyTitle ?? queue.listing?.streetAddress ?? "the property";
			// Same as a decline: rows left are PAID or kept because Stripe already took the money.
			const refunds = await this.paymentModel.updateMany(
				{ application: application._id, kind: PaymentKind.HOLDING_DEPOSIT },
				{ $set: { refundDue: true } }
			);
			if (refunds.matchedCount > 0) {
				await this.notificationsService.notify({
					user: application.landlord,
					kind: NotificationKind.OFFER_EXPIRED,
					title: `Refund the holding deposit for ${title}`,
					body: "Your offer lapsed after the household paid a holding deposit. The law (Tenant Fees Act) requires you to refund it within 7 days, unless they failed to take reasonable steps to agree the tenancy.",
					...notificationTarget("landlord", NotificationTargetKind.APPLICATION, application._id, { listing: application.listing }),
					dedupeKey: `holding-refund:${application._id.toString()}:${key}`
				});
			}
			await this.notificationsService.notifyMany(
				application.applicants.map(applicant => ({
					user: applicant,
					kind: NotificationKind.OFFER_EXPIRED,
					title: `Your offer for ${title} has expired`,
					body: "It wasn't accepted within 15 days, so you're back in the queue.",
					...notificationTarget("student", NotificationTargetKind.APPLICATION, application._id),
					dedupeKey: `offer-expired:${application._id.toString()}:${key}`
				}))
			);
			const next = queue.qualified.find(entry =>
				entry.id !== application._id.toString()
				&& !entry.application.offerExpiredAt
				&& entry.application.stage !== ApplicationStage.OFFERED
			);
			if (!next) continue;
			await this.notificationsService.notify(
				{
					user: application.landlord,
					kind: NotificationKind.NEW_QUALIFIED_HOUSEHOLD,
					title: `Offer expired for ${title}: the next qualified household is waiting`,
					body: `${next.members.length} ${next.members.length === 1 ? "student" : "students"}, first in line. Make them an offer.`,
					...notificationTarget("landlord", NotificationTargetKind.APPLICATION, next.application._id, { listing: application.listing }),
					dedupeKey: `offer-next:${application._id.toString()}:${key}`
				},
				"newQualifiedHousehold"
			);
		}
		return expired;
	}

	/** A household member accepts an open offer, which creates the tenancy. */
	async acceptOffer(applicationId: string): Promise<{ tenancy: string }> {
		const offered = await this.applicationModel.findById(applicationId).lean().exec();
		if (offered) await this.assertNotLet(offered);
		if (offered?.stage === ApplicationStage.OFFERED) await this.tenanciesService.assertNoCurrentTenancy(offered.applicants, offered.listing);
		const application = await this.applicationModel
			.findOneAndUpdate({
				_id: applicationId,
				stage: ApplicationStage.OFFERED,
				offerExpiresAt: { $gt: new Date() },
			}, {
				$set: { stage: ApplicationStage.ACCEPTED }
			}, { new: true })
			.exec();
		if (!application) {
			const existing = await this.applicationModel.findById(applicationId).lean().exec();
			if (existing?.stage === ApplicationStage.ACCEPTED || existing?.stage === ApplicationStage.SIGNED) {
				const tenancy = await this.tenanciesService.createFromApplication(existing);
				return { tenancy: tenancy._id.toString() };
			}
			throw new BadRequestException("There is no open offer to accept. It may have expired.");
		}
		// Re-check after the flip: two households accepting the same listing at once both pass the check above.
		try {
			await this.assertNotLet(application);
		} catch (error) {
			await this.applicationModel.updateOne({ _id: application._id, stage: ApplicationStage.ACCEPTED }, { $set: { stage: ApplicationStage.OFFERED } });
			throw error;
		}
		// The offer is taken: a holding deposit nobody paid can't be paid any more.
		await this.dropUnpaidHoldingDeposits(application._id);
		const tenancy = await this.tenanciesService.createFromApplication(application);
		await this.closeOthers(application);
		return { tenancy: tenancy._id.toString() };
	}

	/** The property is let: every other open application on it is declined, so nobody waits forever. */
	private async closeOthers(application: Pick<Application, "listing"> & { _id: Types.ObjectId }) {
		const others = await this.applicationModel
			.find({ listing: application.listing, _id: { $ne: application._id }, stage: { $in: LANDLORD_OPEN_STAGES } }, { _id: 1 })
			.lean()
			.exec();
		for (const other of others) {
			await this.reject(other._id.toString(), "Property let").catch(error => {
				// Already closed by someone else in the meantime.
				if (!(error instanceof BadRequestException)) throw error;
			});
		}
	}

	/**
	 * Once an offer lapses or is accepted, its unpaid holding deposits go, and
	 * their open Stripe Checkout sessions are closed first so nobody pays a row
	 * that no longer exists. A session Stripe already took payment on keeps its
	 * row, so the webhook can still mark it paid.
	 */
	private async dropUnpaidHoldingDeposits(applicationId: Types.ObjectId) {
		const unpaid = { application: applicationId, kind: PaymentKind.HOLDING_DEPOSIT, status: { $ne: PaymentStatus.PAID } };
		const keep: Types.ObjectId[] = [];
		const key = process.env.STRIPE_SECRET_KEY;
		if (key) {
			const stripe = new StripeClient(key);
			const withSession = await this.paymentModel.find({ ...unpaid, providerRef: /^cs_/ }, { providerRef: 1 }).lean().exec();
			for (const row of withSession) {
				try {
					await stripe.expireCheckoutSession(row.providerRef!);
				} catch (error) {
					if (!(error instanceof StripeApiError)) throw error;
					// Not open any more: already expired (fine to drop) or completed (kept for the webhook).
					const session = await stripe.retrieveCheckoutSession(row.providerRef!).catch(() => null);
					if (!session || session.status === "complete" || session.payment_status === "paid") keep.push(row._id);
				}
			}
		}
		await this.paymentModel.deleteMany({ ...unpaid, _id: { $nin: keep } });
	}

	async reject(applicationId: string, reason?: string): Promise<void> {
		const application = await this.applicationModel
			.findOneAndUpdate({
				_id: applicationId,
				stage: { $in: LANDLORD_OPEN_STAGES },
			}, {
				$set: { stage: ApplicationStage.REJECTED, rejectReason: reason?.trim() || null }
			}, { new: true })
			.populate({ path: "listing", select: "propertyTitle streetAddress" })
			.exec();
		if (!application) {
			throw new BadRequestException("Only open applications can be declined.");
		}
		const listing = application.listing as unknown as { _id: Types.ObjectId; propertyTitle?: string; streetAddress?: string } | null;
		await this.sharesService.revokeForApplication(application._id);
		await this.dropUnpaidHoldingDeposits(application._id);
		// shortcut: no automatic refund yet; the landlord is told and the row flagged until a refund flow exists.
		// Rows left here are PAID or kept because Stripe already took the money (webhook not in yet), so flag both.
		const refunds = await this.paymentModel.updateMany(
			{ application: application._id, kind: PaymentKind.HOLDING_DEPOSIT },
			{ $set: { refundDue: true } }
		);
		if (refunds.matchedCount > 0) {
			await this.notificationsService.notify({
				user: application.landlord,
				kind: NotificationKind.APPLICATION_REJECTED,
				title: `Refund the holding deposit for ${listing?.propertyTitle ?? listing?.streetAddress ?? "this property"}`,
				body: "You declined a household that paid a holding deposit. The law (Tenant Fees Act) requires you to refund it within 7 days.",
				...notificationTarget("landlord", NotificationTargetKind.APPLICATION, application._id, { listing: listing?._id }),
				dedupeKey: `holding-refund:${application._id.toString()}`
			});
		}
		await this.notificationsService.notifyMany(
			application.applicants.map(applicant => ({
				user: applicant,
				kind: NotificationKind.APPLICATION_REJECTED,
				title: `Update on ${listing?.propertyTitle ?? listing?.streetAddress ?? "your application"}`,
				body: application.rejectReason
					? `The landlord declined your application: ${application.rejectReason}`
					: "The landlord declined your application.",
				...notificationTarget("student", NotificationTargetKind.APPLICATION, application._id),
				dedupeKey: `rejected:${application._id.toString()}`
			}))
		);
	}

	async send(applicationId: string): Promise<void> {
		const pending = await this.applicationModel.findById(applicationId).lean().exec();
		if (pending) await this.assertNotLet(pending);
		const application = await this.applicationModel
			.findOneAndUpdate({
				_id: applicationId,
				stage: ApplicationStage.NOT_SENT,
			}, {
				$set: { stage: ApplicationStage.SENT, sentAt: new Date() }
			}, { new: true })
			.exec();
		if (!application) {
			throw new BadRequestException("Application has already been sent.");
		}

		await this.converstaionModel.updateOne(
			{ _id: application.conversation },
			{ $addToSet: { users: application.landlord } }
		).exec();

		// Sending gives the landlord 14 days on every member's documents.
		await this.sharesService.shareForApplication({
			ownerIds: application.applicants,
			viewer: application.landlord,
			listing: application.listing,
			application: application._id,
		});
		await this.notifyIfQualified(application);
	}

	private async notifyIfQualified(application: HydratedDocument<Application>): Promise<void> {
		const populated = await this.applicationModel
			.findById(application._id)
			.populate({ path: "applicants", select: "name documents studentVerifiedAt universityEmail" })
			.populate({ path: "listing", select: "propertyTitle streetAddress numOfPeople criteria" })
			.lean()
			.exec();
		if (!populated) return;
		const members = populated.applicants as unknown as { name?: string; documents?: PassportDocumentInput[] }[];
		const listing = populated.listing as unknown as { propertyTitle?: string; streetAddress?: string; numOfPeople?: number; criteria?: ReadinessCriteria } | null;
		const household = householdReadiness(members, listing?.numOfPeople, new Date(), listing?.criteria);
		if (!household.qualified) return;
		await this.notificationsService.notify(
			{
				user: application.landlord,
				kind: NotificationKind.NEW_QUALIFIED_HOUSEHOLD,
				title: `New qualified household for ${listing?.propertyTitle ?? listing?.streetAddress ?? "your property"}`,
				body: `${members.length} ${members.length === 1 ? "student" : "students"}, every Seek Passport verified.`,
				...notificationTarget("landlord", NotificationTargetKind.APPLICATION, application._id, { listing: application.listing }),
				dedupeKey: `qualified:${application._id.toString()}`
			},
			"newQualifiedHousehold"
		);
	}

	async findApplicationById(id: string): Promise<ApplicationDto> {
		if (!Types.ObjectId.isValid(id)) {
			throw new BadRequestException("Invalid application ID");
		}
		const application = await this.applicationModel
			.findById(id)
			.exec();
		if (!application) {
			throw new NotFoundException("Application not found");
		}
		return this.toDto(application);
	}

	/**
	 * Mints a fresh invite secret for an application and returns it once.
	 * Admins (creator, and landlord once sent) can invite at any stage.
	 *
	 * Rotating on every share means a link that has been passed around beyond
	 * the intended group can be revoked simply by sharing again.
	 */
	async createInvite(applicationId: string): Promise<{
		inviteToken: string;
		expiresAt: Date;
	}> {
		if (!Types.ObjectId.isValid(applicationId)) {
			throw new BadRequestException("Invalid application ID");
		}

		const inviteToken = generateToken();
		const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
		const updated = await this.applicationModel.findOneAndUpdate(
			{ _id: applicationId },
			{
				$set: {
					inviteTokenHash: hashToken(inviteToken),
					inviteTokenExpires: expiresAt
				}
			}
		);
		if (!updated) {
			throw new NotFoundException("Application not found");
		}

		return { inviteToken, expiresAt };
	}

	async join(
		applicationId: string,
		userId: string,
		inviteToken: string
	): Promise<void> {
		if (!Types.ObjectId.isValid(applicationId)) {
			throw new BadRequestException("Invalid application id");
		}

		const application: Application | null =
			await this.applicationModel.findById(applicationId);

		if (!application) {
			throw new BadRequestException("Invalid application id");
		}

		// The application id travels in shareable chat URLs, so it cannot be the
		// thing that authorizes joining. A valid, unexpired invite must be
		// presented as well.
		if (
			!application.inviteTokenHash ||
			!application.inviteTokenExpires ||
			application.inviteTokenExpires <= new Date() ||
			!tokensMatch(inviteToken, application.inviteTokenHash)
		) {
			throw new ForbiddenException("Invite is not valid or has expired.");
		}

		// Once an offer is made (or the application is closed) the household is fixed.
		const joinable = [ApplicationStage.NOT_SENT, ApplicationStage.SENT, ApplicationStage.VIEWED];
		const updatedApplication: Application | null =
			await this.applicationModel.findOneAndUpdate(
				{ _id: applicationId, stage: { $in: joinable } },
				{ $addToSet: { applicants: new Types.ObjectId(userId) } },
			);

		if (!updatedApplication) {
			throw new BadRequestException("This household can no longer change: an offer has been made or the application is closed.");
		}

		await this.converstaionModel.updateOne(
			{ _id: application.conversation },
			{ $addToSet: { users: new Types.ObjectId(userId) } }
		).exec();

		// Joining a group that already applied shares the newcomer's documents too.
		if (updatedApplication.stage !== ApplicationStage.NOT_SENT) {
			await this.sharesService.shareForApplication({
				ownerIds: [userId],
				viewer: application.landlord,
				listing: application.listing,
				application: application._id,
			});
		}
	}

	/** A member leaves the group. The creator deletes the application instead. */
	async leave(applicationId: string, userId: string): Promise<void> {
		if (!Types.ObjectId.isValid(applicationId)) {
			throw new BadRequestException("Invalid application id");
		}

		const application: Application | null =
			await this.applicationModel.findById(applicationId);
		if (!application) {
			throw new NotFoundException("Application not found");
		}
		if (application.owner?.toString() === userId) {
			throw new BadRequestException(
				"The creator can't leave their application; delete it instead."
			);
		}

		const member = new Types.ObjectId(userId);
		await this.applicationModel.findOneAndUpdate(
			{ _id: applicationId },
			{ $pull: { applicants: member } },
		);
		await this.sharesService.revokeForApplication(applicationId, [member]);
		await this.converstaionModel.updateOne(
			{ _id: application.conversation },
			{ $pull: { users: member } }
		).exec();
	}

	async sendApplication(applicationId: string): Promise<void> {
		const application: Application | null =
			await this.applicationModel.findById(applicationId);
		if (!application) {
			throw new BadRequestException("Invalid application id");
		}
		if (application.stage === ApplicationStage.NOT_SENT) {
			await this.applicationModel.findOneAndUpdate(
				{ _id: applicationId },
				{ $set: { stage: ApplicationStage.SENT } },
				{ new: true }
			);
		} else {
			throw new BadRequestException("Application already send.");
		}
	}

	async getByConversation(
		conversationId: string,
		userId: string,
	): Promise<ApplicationDto> {
		if (!Types.ObjectId.isValid(conversationId)) {
			throw new BadRequestException("Invalid conversation ID");
		}
		const application = await this.applicationModel
			.findOne({ conversation: conversationId })
			.exec();
		if (!application) {
			throw new NotFoundException("Application not found");
		}
		await this.conversationAccessService.assertCanAccess(
			conversationId,
			userId,
		);
		return this.toDto(application);
	}

	private toDto(
		application: HydratedDocument<Application>,
		extras?: Partial<Pick<ApplicationDto, "readiness" | "qualified" | "members" | "criteria" | "queuePosition" | "queueSize">>,
	): ApplicationDto {
		const value = application.toObject() as unknown as Record<string, unknown>;
		if (
			value.listing &&
			typeof value.listing === "object" &&
			!Array.isArray(value.listing) &&
			!(value.listing instanceof Types.ObjectId)
		) {
			const safeListing = {
				...(value.listing as Record<string, unknown>),
			};
			delete safeListing.registerOfTitleKey;
			delete safeListing.registrationNumber;
			delete safeListing.likedBy;
			value.listing = safeListing;
		}
		// When applicants were populated, expose them as users too; the DTO
		// reduces `applicants` itself back to ids for existing consumers.
		if (
			Array.isArray(value.applicants) &&
			value.applicants.some(
				a => a && typeof a === "object" && !(a instanceof Types.ObjectId)
			)
		) {
			value.applicantUsers = value.applicants;
		}
		const dto = plainToInstance(ApplicationDto, value, {
			excludeExtraneousValues: true,
		});
		// Assigned after the transform: these are computed plain objects the
		// DTO metadata would otherwise strip.
		return extras ? Object.assign(dto, extras) : dto;
	}

	private isDuplicateKeyError(error: unknown): error is { code: number } {
		return (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			(error as { code?: number }).code === 11000
		);
	}
}
