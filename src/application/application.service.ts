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
import { compareForLandlord, householdCap, householdReadiness, ReadinessCriteria } from "./readiness";
import { parseUniversityDetails } from "./university-details";
import { OFFER_WINDOW_DAYS } from "./offer";
import { missingDocuments } from "./required-documents";
import { Payment } from "../payments/payment.schema";
import { PaymentKind, PaymentStatus } from "../payments/payment.enums";
import { StripeApiError, StripeClient } from "../payments/stripe";
import { notifyHoldingRefund, refundPayment } from "../payments/refund";
import { holdingDepositPerPersonCapPence } from "../tenancies/compliance";

/** How long a shared invite link stays usable. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Stages where members may still join or leave; afterwards the household is fixed. */
const HOUSEHOLD_OPEN_STAGES = [ApplicationStage.NOT_SENT, ApplicationStage.SENT, ApplicationStage.VIEWED];

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
					// Already a member of a household application for this listing.
					{ listing: listing._id, applicants: user._id },
				]
			})
			.exec();
		if (existingApplication) {
			// The household's own accepted application is excluded, so it still gets it back.
			await this.assertNotLet(existingApplication);
			return this.toDto(existingApplication);
		}

		if (listing.availableUntil && new Date(listing.availableUntil) <= new Date()) {
			throw new BadRequestException("This property is no longer available for the dates listed.");
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
				// The winner may be this user's own application or a household they just joined.
				const existing = await this.applicationModel
					.findOne({ listing: listing._id, applicants: user._id })
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
		if (Types.ObjectId.isValid(applicationId)) {
			const current = await this.applicationModel.findById(applicationId).lean().exec();
			if (current?.stage === ApplicationStage.OFFERED) {
				await this.withdrawOffer(current);
				return;
			}
			// An accepted/signed application backs a tenancy and its payments; deleting it would orphan them.
			if (current && [ApplicationStage.ACCEPTED, ApplicationStage.SIGNED].includes(current.stage as ApplicationStage)) {
				throw new ConflictException("An accepted or signed application cannot be deleted.");
			}
			await this.sharesService.revokeForApplication(applicationId);
		}
		const deleted = await this.applicationModel.findOneAndDelete({
			_id: applicationId
		});
		// Close the conversation to new messages; members stay so they keep the history and can still report (flags linkedTo).
		if (deleted?.conversation) {
			await this.converstaionModel.updateOne({ _id: deleted.conversation }, { $set: { closedAt: new Date() } }).exec();
		}
	}

	/** An offered household may withdraw; keep its audit row and return any paid reservation fee. */
	private async withdrawOffer(application: Application & { _id: Types.ObjectId }) {
		const withdrawn = await this.applicationModel.findOneAndUpdate(
			{ _id: application._id, stage: ApplicationStage.OFFERED },
			{ $set: { stage: ApplicationStage.WITHDRAWN, offerExpiresAt: null, holdingDeposit: null } },
			{ new: true }
		).exec();
		if (!withdrawn) throw new ConflictException("This offer can no longer be withdrawn.");
		await this.sharesService.revokeForApplication(application._id);
		await this.dropUnpaidHoldingDeposits(application._id);
		await this.refundHoldingDeposits(application._id);
		if (application.conversation) {
			await this.converstaionModel.updateOne({ _id: application.conversation }, { $set: { closedAt: new Date() } }).exec();
		}
		const queue = await this.queueFor(application.listing, new Date());
		const title = queue.listing?.propertyTitle ?? queue.listing?.streetAddress ?? "the property";
		await this.notificationsService.notify({
			user: application.landlord,
			kind: NotificationKind.OFFER_WITHDRAWN,
			title: `The household withdrew from your offer for ${title}`,
			body: "They turned the offer down. Any holding deposit they paid is refunded automatically.",
			...notificationTarget("landlord", NotificationTargetKind.APPLICATION, application._id, { listing: application.listing }),
			dedupeKey: `offer-withdrawn:${application._id.toString()}`
		});
		await this.notifyNextQualified(application, queue.qualified, `Offer withdrawn for ${title}`, `offer-next:${application._id.toString()}:withdrawn`);
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
		const all = (open ?? []).map(application => this.householdEntry(application, listing, now))
			// A household whose offer lapsed goes to the back of the queue (stable sort keeps the rest in order).
			.sort((a, b) => Number(!!a.application.offerExpiredAt) - Number(!!b.application.offerExpiredAt));
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

		// A student only books on a listing still published (not hidden, unverified or let); the landlord may still move one.
		const listing = isLandlord
			? await this.listingService.findListingById(application.listing.toString())
			: await this.assertListingOpen(application);
		if (listing.availableUntil && new Date(listing.availableUntil) <= new Date()) {
			throw new BadRequestException("This property is no longer available for the dates listed.");
		}
		// Lapsed slots stay stored until the landlord next saves the listing; only future ones bind the student.
		const slots = (listing.viewingSlots ?? []).map(slot => new Date(slot).getTime()).filter(t => t > Date.now());
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
					: notificationTarget("student", NotificationTargetKind.APPLICATION, application._id))
				// No dedupeKey: each booking is a user action, and moving back to an earlier time must notify again.
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
		if (current.lapseCleanupPending) throw new ConflictException("The last offer is still being closed. Try again in an hour.");
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
				lapseCleanupPending: { $ne: true },
			}, {
				$set: { stage: ApplicationStage.ACCEPTED }
			}, { new: true })
			.exec();
		if (!application) {
			throw new BadRequestException("Only open applications can be accepted.");
		}
		// Not on an ACCEPTED retry: a re-run must not extend the document shares again.
		if (current.stage !== ApplicationStage.ACCEPTED) await this.refreshShares(application);
		const tenancy = await this.createOrReopen(application, current.stage as ApplicationStage);
		// Only once the tenancy exists (a 409 reopens the offer, whose deposits must stay payable); also on an ACCEPTED retry, in case it failed here.
		if (current.stage === ApplicationStage.OFFERED || current.stage === ApplicationStage.ACCEPTED) await this.dropUnpaidHoldingDeposits(application._id);
		await this.closeOthers(application);
		return { tenancy: tenancy._id.toString() };
	}

	/**
	 * The landlord offers the room to a household. The household gets the configured window to accept,
	 * and the listing's holding deposit is recorded with the offer.
	 */
	async offer(applicationId: string): Promise<ApplicationDto> {
		const now = new Date();
		const current = await this.applicationModel.findById(applicationId).exec();
		if (!current) throw new NotFoundException("Application not found");
		if (current.lapseCleanupPending) throw new ConflictException("The last offer is still being closed. Try again in an hour.");
		const lapsed = current.stage === ApplicationStage.OFFERED
			&& !!current.offerExpiresAt && current.offerExpiresAt <= now;
		if (!LANDLORD_OPEN_STAGES.includes(current.stage as ApplicationStage) || (current.stage === ApplicationStage.OFFERED && !lapsed)) {
			throw new BadRequestException("An offer can only be made on an open application, or renewed once the last one lapsed.");
		}
		await this.assertNextInQueue(current, now);
		const listing = await this.listingService.findListingById(current.listing.toString());
		if (listing.availableUntil && new Date(listing.availableUntil) <= now) {
			throw new BadRequestException("This listing's available-until date has passed. Edit the dates before making an offer.");
		}
		const holdingDeposit = listing.holdingDeposit == null || !Number.isFinite(listing.monthlyRent)
			? listing.holdingDeposit ?? null
			: Math.min(listing.holdingDeposit, holdingDepositPerPersonCapPence(Math.round(listing.monthlyRent! * 100), listing.numOfPeople) / 100);
		const application = await this.applicationModel
			.findOneAndUpdate({
				_id: applicationId,
				stage: current.stage,
				// The sweep's lapse clean-up would otherwise drop this offer's new deposit rows and revoke its shares.
				lapseCleanupPending: { $ne: true },
			}, {
				$set: {
					stage: ApplicationStage.OFFERED,
					offeredAt: now,
					offerExpiredAt: null,
					offerExpiresAt: new Date(now.getTime() + OFFER_WINDOW_DAYS * 24 * 60 * 60 * 1000),
					holdingDeposit,
				}
			}, { new: true })
			.exec();
		if (!application) {
			throw new BadRequestException("This application changed while you were making the offer. Try again.");
		}
		await this.refreshShares(application);
		await this.createHoldingDeposits(application, holdingDeposit);
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

	/** The landlord checks documents before offering or accepting: a fresh 14 days, never reviving a share a student revoked. */
	private async refreshShares(application: HydratedDocument<Application>) {
		await this.sharesService.shareForApplication({
			ownerIds: application.applicants,
			viewer: application.landlord,
			listing: application.listing,
			application: application._id,
		});
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

	/** create() checks the listing once; a draft sent or joined later must still find it published, in date and not let. */
	private async assertListingOpen(application: Pick<Application, "listing"> & { _id?: Types.ObjectId }) {
		await this.assertNotLet(application);
		const listing = await this.listingService.findPublishedListingById(application.listing.toString())
			.catch(error => { if (error instanceof NotFoundException) return null; throw error; });
		if (!listing || (listing.availableUntil && new Date(listing.availableUntil) <= new Date())) {
			throw new BadRequestException("This property is no longer available.");
		}
		return listing;
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
	 * drops any extra one, and never charges a member who already paid for an
	 * offer still standing. Seek's
	 * fee is on rent only, so the landlord receives the whole holding deposit.
	 */
	private async createHoldingDeposits(application: HydratedDocument<Application>, pounds?: number | null) {
		const amount = Math.round(Number(pounds) * 100);
		const valid = Number.isFinite(amount) && amount > 0;
		const base = { application: application._id, kind: PaymentKind.HOLDING_DEPOSIT };
		// A deposit flagged refundDue is owed back from an earlier offer: it neither covers nor gets reused for this one.
		const existing = (await this.paymentModel.find(base).lean().exec()).filter(row => !row.refundDue && !row.refundedAt);
		const paid = new Set(existing.filter(row => row.status === PaymentStatus.PAID).map(row => row.tenant.toString()));
		const members = new Set(application.applicants.map(applicant => applicant.toString()));
		const kept = new Map<string, (typeof existing)[number]>();
		// Rows with a provider reference first, so an open session is the one kept.
		for (const row of [...existing].sort((a, b) => Number(!!b.providerRef) - Number(!!a.providerRef))) {
			const tenant = row.tenant.toString();
			if (valid && row.status !== PaymentStatus.PAID && members.has(tenant) && !paid.has(tenant) && !kept.has(tenant)) kept.set(tenant, row);
		}
		const keptIds = new Set([...kept.values()].map(row => row._id.toString()));
		const staleRows = existing.filter(row => row.status !== PaymentStatus.PAID && !keptIds.has(row._id.toString()));
		// Close the open session of every row dropped or repriced, so nobody pays a row that is gone.
		const paidAtStripe = await this.closeCheckoutSessions([...staleRows, ...[...kept.values()].filter(row => row.amount !== amount)]);
		const stale = staleRows.filter(row => !paidAtStripe.has(row._id.toString())).map(row => row._id);
		if (stale.length > 0) await this.paymentModel.deleteMany({ _id: { $in: stale }, status: { $ne: PaymentStatus.PAID } });
		for (const row of kept.values()) {
			// Stripe already took the old amount: leave the row as it is so the webhook can still mark it paid.
			if (paidAtStripe.has(row._id.toString())) continue;
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
	 * Hourly: an offer nobody accepted within the configured window goes back to the queue. The
	 * household is told, unpaid holding deposits are dropped, and the landlord
	 * is pointed at the next qualified household.
	 */
	async expireOffers(now: Date = new Date()): Promise<number> {
		// Lapsed offers to claim, plus claimed ones whose clean-up threw on an earlier sweep.
		const lapsed = await this.applicationModel
			.find({ $or: [{ stage: ApplicationStage.OFFERED, offerExpiresAt: { $lte: now } }, { lapseCleanupPending: true }] })
			.exec();
		let expired = 0;
		let failure: unknown;
		for (const found of lapsed) {
			try {
				let application = found;
				if (!found.lapseCleanupPending) {
					// Claim before any clean-up: a landlord accepting or renewing this offer at the same moment either wins (we skip) or finds it reopened.
					const claimed = await this.applicationModel.findOneAndUpdate(
						{ _id: found._id, stage: ApplicationStage.OFFERED, offerExpiresAt: found.offerExpiresAt },
						{
							$set: {
								stage: found.viewingAt ? ApplicationStage.VIEWED : ApplicationStage.SENT,
								offeredAt: null,
								offerExpiresAt: null,
								offerExpiredAt: found.offerExpiresAt,
								holdingDeposit: null,
								lapseCleanupPending: true,
							}
						},
						{ new: true }
					).exec();
					if (!claimed) continue;
					application = claimed;
					expired += 1;
				}
				await this.finishLapse(application, now);
				await this.applicationModel.updateOne({ _id: application._id, lapseCleanupPending: true }, { $set: { lapseCleanupPending: false } }).exec();
			} catch (error) {
				// The marker stays set, so the next sweep retries; carry on so one stuck offer doesn't hold back the others' refund flags.
				failure ??= error;
			}
		}
		if (failure) throw failure;
		return expired;
	}

	/** Clean-up after an offer lapses. Every step is safe to repeat: the sweep reruns it until it all succeeds. */
	private async finishLapse(application: Application & { _id: Types.ObjectId }, now: Date) {
		await this.sharesService.revokeForApplication(application._id);
		await this.dropUnpaidHoldingDeposits(application._id);
		const key = application.offerExpiredAt?.toISOString();
		const queue = await this.queueFor(application.listing, now);
		const title = queue.listing?.propertyTitle ?? queue.listing?.streetAddress ?? "the property";
		// Same as a decline: rows left are PAID or kept because Stripe already took the money.
		const refunds = await this.refundHoldingDeposits(application._id);
		if (refunds.acceptedCount > 0) {
			await this.notificationsService.notify({
				user: application.landlord,
				kind: NotificationKind.OFFER_EXPIRED,
				title: `Refund the holding deposit for ${title}`,
				body: "Your offer lapsed after the household paid a holding deposit. Seek has started the automatic refund.",
				...notificationTarget("landlord", NotificationTargetKind.APPLICATION, application._id, { listing: application.listing }),
				dedupeKey: `holding-refund:${application._id.toString()}:${key}`
			});
		}
		// Declined while this clean-up was pending (reject() is not blocked by the marker): no "back in the queue".
		if (application.stage !== ApplicationStage.REJECTED) await this.notificationsService.notifyMany(
			application.applicants.map(applicant => ({
				user: applicant,
				kind: NotificationKind.OFFER_EXPIRED,
				title: `Your offer for ${title} has expired`,
				body: `It wasn't accepted within ${OFFER_WINDOW_DAYS} days, so you're back in the queue.`,
				...notificationTarget("student", NotificationTargetKind.APPLICATION, application._id),
				dedupeKey: `offer-expired:${application._id.toString()}:${key}`
			}))
		);
		const pointedAtNext = await this.notifyNextQualified(application, queue.qualified, `Offer expired for ${title}`, `offer-next:${application._id.toString()}:${key}`);
		// Nobody else waiting and no refund message sent: the landlord would otherwise never hear the offer lapsed.
		if (!pointedAtNext && refunds.acceptedCount === 0 && application.stage !== ApplicationStage.REJECTED) {
			await this.notificationsService.notify({
				user: application.landlord,
				kind: NotificationKind.OFFER_EXPIRED,
				title: `Your offer for ${title} expired`,
				body: "The household didn't accept it in time, so it lapsed. You can renew the offer.",
				...notificationTarget("landlord", NotificationTargetKind.APPLICATION, application._id, { listing: application.listing }),
				dedupeKey: `offer-expired-landlord:${application._id.toString()}:${key}`
			});
		}
	}

	/** The offer is gone (lapsed or withdrawn): point the landlord at the first qualified household still waiting. */
	private async notifyNextQualified(
		application: Application & { _id: Types.ObjectId },
		qualified: Awaited<ReturnType<ApplicationService["queueFor"]>>["qualified"],
		heading: string,
		dedupeKey: string
	): Promise<boolean> {
		const next = qualified.find(entry =>
			entry.id !== application._id.toString()
			&& !entry.application.offerExpiredAt
			&& entry.application.stage !== ApplicationStage.OFFERED
		);
		if (!next) return false;
		await this.notificationsService.notify(
			{
				user: application.landlord,
				kind: NotificationKind.NEW_QUALIFIED_HOUSEHOLD,
				title: `${heading}: the next qualified household is waiting`,
				body: `${next.members.length} ${next.members.length === 1 ? "student" : "students"}, first in line. Make them an offer.`,
				...notificationTarget("landlord", NotificationTargetKind.APPLICATION, next.application._id, { listing: application.listing }),
				dedupeKey
			},
			"newQualifiedHousehold"
		);
		// True once a next household exists, even if muted or already sent on a rerun: that is the landlord's message for this lapse.
		return true;
	}

	/** A household member accepts an open offer, which creates the tenancy. */
	async acceptOffer(applicationId: string): Promise<{ tenancy: string }> {
		const offered = await this.applicationModel.findById(applicationId).lean().exec();
		if (offered) await this.assertNotLet(offered);
		if (offered?.stage === ApplicationStage.OFFERED) {
			await this.tenanciesService.assertNoCurrentTenancy(offered.applicants, offered.listing);
			// Rent to a deleted or suspended landlord can never be paid (payments refuse them), so don't create the tenancy.
			const landlord = offered.landlord ? await this.userSevice.getUserById(offered.landlord.toString()) : null;
			if (!landlord || landlord.deletedAt || landlord.suspendedAt) {
				throw new BadRequestException("This landlord is no longer active on Seek, so the offer can't be accepted.");
			}
		}
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
				// A retry after the drop below failed: finish it.
				await this.dropUnpaidHoldingDeposits(existing._id);
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
		const tenancy = await this.createOrReopen(application, ApplicationStage.OFFERED);
		const listing = await this.listingService.findListingById(application.listing.toString()).catch(() => null);
		await this.notificationsService.notify({
			user: application.landlord,
			kind: NotificationKind.OFFER_ACCEPTED,
			title: `Your offer for ${listing?.propertyTitle ?? listing?.streetAddress ?? "your property"} was accepted`,
			body: "The household accepted. Their tenancy is set up in Seek.",
			...notificationTarget("landlord", NotificationTargetKind.TENANCY, tenancy._id),
			dedupeKey: `offer-accepted:${application._id.toString()}`
		});
		// The offer is taken: a holding deposit nobody paid can't be paid any more. Not before: a 409 above reopens the offer.
		await this.dropUnpaidHoldingDeposits(application._id);
		await this.closeOthers(application);
		return { tenancy: tenancy._id.toString() };
	}

	/**
	 * A member's other tenancy can land while this accept waits on Stripe: createFromApplication then
	 * refuses with a 409. Reopen the application so the listing isn't left ACCEPTED with no tenancy.
	 */
	private async createOrReopen(application: Application & { _id: Types.ObjectId }, previousStage: ApplicationStage) {
		try {
			return await this.tenanciesService.createFromApplication(application);
		} catch (error) {
			if (error instanceof ConflictException && previousStage !== ApplicationStage.ACCEPTED) {
				await this.applicationModel.updateOne({ _id: application._id, stage: ApplicationStage.ACCEPTED }, { $set: { stage: previousStage } });
			}
			throw error;
		}
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
	 * their open Stripe Checkout sessions (or PaymentIntents, from POST /payments/:id/pay)
	 * are closed first so nobody pays a row that no longer exists. One Stripe already
	 * took (or is taking) payment on keeps its row, so the webhook can still mark it paid.
	 */
	private async dropUnpaidHoldingDeposits(applicationId: Types.ObjectId, tenants?: Types.ObjectId[]) {
		const unpaid = { application: applicationId, kind: PaymentKind.HOLDING_DEPOSIT, status: { $ne: PaymentStatus.PAID }, ...(tenants ? { tenant: { $in: tenants } } : {}) };
		const keep: Types.ObjectId[] = [];
		if (process.env.STRIPE_SECRET_KEY) {
			const withSession = await this.paymentModel.find({ ...unpaid, providerRef: /^(cs|pi)_/ }, { providerRef: 1, stripeAccountId: 1 }).lean().exec();
			const paid = await this.closeCheckoutSessions(withSession);
			keep.push(...withSession.filter(row => paid.has(row._id.toString())).map(row => row._id));
		}
		await this.paymentModel.deleteMany({ ...unpaid, _id: { $nin: keep } });
	}

	/** Flags every retained holding deposit (only these tenants' when given) and immediately refunds each settled payment. */
	private async refundHoldingDeposits(applicationId: Types.ObjectId, tenants?: Types.ObjectId[]) {
		const scope = { application: applicationId, kind: PaymentKind.HOLDING_DEPOSIT, ...(tenants ? { tenant: { $in: tenants } } : {}) };
		const result = await this.paymentModel.updateMany(
			{ ...scope, refundDue: { $ne: true }, autoRefund: { $ne: true }, refundedAt: null },
			{ $set: { refundDue: true, autoRefund: true } }
		);
		const due = await this.paymentModel
			.find({ ...scope, refundDue: true, autoRefund: true, status: PaymentStatus.PAID, refundedAt: null })
			.lean()
			.exec();
		let acceptedCount = 0;
		for (const payment of due) {
			const accepted = await refundPayment(this.paymentModel, payment, process.env.STRIPE_SECRET_KEY);
			if (accepted) acceptedCount += 1;
			await notifyHoldingRefund(this.notificationsService, this.paymentModel, payment, accepted);
		}
		return { ...result, acceptedCount };
	}

	/** Expires each row's open Checkout session or cancels its PaymentIntent; returns the ids of rows Stripe already took (or is taking) payment on. */
	private async closeCheckoutSessions(rows: { _id: Types.ObjectId; providerRef?: string | null; stripeAccountId?: string | null }[]): Promise<Set<string>> {
		const paid = new Set<string>();
		const key = process.env.STRIPE_SECRET_KEY;
		const open = rows.filter(row => row.providerRef?.startsWith("cs_") || row.providerRef?.startsWith("pi_"));
		if (!key || open.length === 0) return paid;
		for (const row of open) {
			// The session or intent lives on the landlord's account (direct charge), or Seek's for legacy rows.
			const stripe = new StripeClient(key, row.stripeAccountId ?? undefined);
			if (row.providerRef!.startsWith("pi_")) {
				try {
					await stripe.cancelPaymentIntent(row.providerRef!);
				} catch (error) {
					if (!(error instanceof StripeApiError)) throw error;
					// Not cancellable: succeeded or processing (kept for the webhook); only an already-canceled intent can go.
					const intent = await stripe.retrievePaymentIntent(row.providerRef!).catch(() => null);
					if (intent?.status !== "canceled") paid.add(row._id.toString());
				}
				continue;
			}
			try {
				await stripe.expireCheckoutSession(row.providerRef!);
			} catch (error) {
				if (!(error instanceof StripeApiError)) throw error;
				// Not open any more: already expired (fine to drop) or completed (kept for the webhook).
				const session = await stripe.retrieveCheckoutSession(row.providerRef!).catch(() => null);
				if (!session || session.status === "complete" || session.payment_status === "paid") paid.add(row._id.toString());
			}
		}
		return paid;
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
		// Rows left here are PAID or kept because Stripe already took the money (webhook not in yet), so flag both.
		const refunds = await this.refundHoldingDeposits(application._id);
		if (refunds.acceptedCount > 0) {
			await this.notificationsService.notify({
				user: application.landlord,
				kind: NotificationKind.APPLICATION_REJECTED,
				title: `Refund the holding deposit for ${listing?.propertyTitle ?? listing?.streetAddress ?? "this property"}`,
				body: "You declined a household that paid a holding deposit. Seek has started the automatic refund.",
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
		if (pending) await this.assertListingOpen(pending);
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

		// One application per listing per student: joining a second one would hide it in /mine.
		if (await this.applicationModel.exists({
			_id: { $ne: application._id },
			listing: application.listing,
			applicants: new Types.ObjectId(userId),
		})) {
			throw new BadRequestException("You already have an application for this listing.");
		}

		const listing = await this.assertListingOpen(application);
		const cap = householdCap(listing.numOfPeople, listing.criteria);
		const alreadyMember = application.applicants.some(applicant => applicant.toString() === userId);
		if (cap && !alreadyMember && application.applicants.length >= cap) {
			throw new BadRequestException("This household is already full for this property.");
		}
		const joiner = await this.userSevice.getUserById(userId);
		const missing = missingDocuments(listing, (joiner?.documents ?? []).map(document => document.type));
		if (missing.length > 0) {
			throw new BadRequestException(`Missing required documents: ${missing.join(", ")}. Add them to your Seek Passport, then join.`);
		}

		// Once an offer is made (or the application is closed) the household is fixed.
		const joinable = HOUSEHOLD_OPEN_STAGES;
		let updatedApplication: Application | null;
		try {
			updatedApplication = await this.applicationModel.findOneAndUpdate(
				{ _id: applicationId, stage: { $in: joinable } },
				{ $addToSet: { applicants: new Types.ObjectId(userId) } },
			);
		} catch (error) {
			// The unique (listing, applicants) index caught a concurrent create or join.
			if (this.isDuplicateKeyError(error)) {
				throw new BadRequestException("You already have an application for this listing.");
			}
			throw error;
		}

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
				// Joining again is a fresh consent, even after the student stopped sharing.
				reconsent: !alreadyMember,
			});
			// The newcomer may complete the household: tell the landlord (deduped per application).
			await this.notifyIfQualified(application as HydratedDocument<Application>);
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

		if (!HOUSEHOLD_OPEN_STAGES.includes(application.stage as ApplicationStage)) {
			throw new BadRequestException("This household can no longer change: an offer has been made or the application is closed.");
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

	/**
	 * A deleted account leaves its open or offered households: ownership passes to the next member, and an application
	 * left with nobody is deleted (an offer is withdrawn). The leaver's holding deposit is dropped or refunded.
	 */
	async releaseDeletedMember(userId: Types.ObjectId): Promise<void> {
		const applications = await this.applicationModel
			.find({ applicants: userId, stage: { $in: [...HOUSEHOLD_OPEN_STAGES, ApplicationStage.OFFERED] } })
			.exec();
		for (const application of applications) {
			const users = await Promise.all(application.applicants.map(applicant => this.userSevice.getUserById(applicant.toString())));
			// Accounts deleted before this cleanup existed leave too, so ownership lands on a live member.
			const gone = application.applicants.filter((applicant, i) => applicant.toString() === userId.toString() || !users[i] || users[i]?.deletedAt);
			const remaining = application.applicants.filter(applicant => !gone.includes(applicant));
			if (!remaining.length) {
				await this.delete(application._id.toString());
				continue;
			}
			const ownerGone = gone.some(applicant => applicant.toString() === application.owner?.toString());
			await this.applicationModel.updateOne(
				{ _id: application._id },
				{ $pull: { applicants: { $in: gone } }, ...(ownerGone ? { $set: { owner: remaining[0] } } : {}) }
			);
			await this.sharesService.revokeForApplication(application._id.toString(), gone);
			await this.converstaionModel.updateOne({ _id: application.conversation }, { $pull: { users: { $in: gone } } }).exec();
			if (application.stage === ApplicationStage.OFFERED) {
				await this.dropUnpaidHoldingDeposits(application._id, gone);
				await this.refundHoldingDeposits(application._id, gone);
			}
		}
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
