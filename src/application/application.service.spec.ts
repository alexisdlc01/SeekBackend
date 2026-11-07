import { Types } from "mongoose";
import { ApplicationService } from "./application.service";
import { User } from "../users/users.schema";
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { ApplicationStage } from "./enums/application-stage.enum";
import { hashToken } from "../shared/tokens";
import { StripeApiError, StripeClient } from "../payments/stripe";

function documentFrom(value: Record<string, unknown>) {
	return {
		...value,
		toObject: () => value,
	};
}

describe("ApplicationService", () => {
	const listingId = new Types.ObjectId();
	const userId = new Types.ObjectId();
	const landlordId = new Types.ObjectId();
	const conversationId = new Types.ObjectId();
	const applicationId = new Types.ObjectId();
	const listing = {
		_id: listingId,
		landlord: landlordId,
		propertyTitle: "Market Street Flat",
	};
	const user = {
		_id: userId,
		name: "Student",
	} as User;

	let applicationModel: {
		findOne: jest.Mock;
		findById: jest.Mock;
		findOneAndUpdate: jest.Mock;
		create: jest.Mock;
		exists: jest.Mock;
	};
	let conversationModel: {
		create: jest.Mock;
		deleteOne: jest.Mock;
		updateOne: jest.Mock;
	};
	let listingService: {
		findPublishedListingById: jest.Mock;
	};
	let conversationAccessService: {
		assertCanAccess: jest.Mock;
	};
	let sharesService: { shareForApplication: jest.Mock };
	let service: ApplicationService;

	beforeEach(() => {
		applicationModel = {
			findOne: jest.fn(),
			findById: jest.fn(),
			findOneAndUpdate: jest.fn(),
			create: jest.fn(),
			exists: jest.fn().mockResolvedValue(null),
		};
		conversationModel = {
			create: jest.fn(),
			deleteOne: jest.fn().mockResolvedValue(undefined),
			updateOne: jest.fn(),
		};
		listingService = {
			findPublishedListingById: jest.fn().mockResolvedValue(listing),
		};
		conversationAccessService = {
			assertCanAccess: jest.fn().mockResolvedValue(undefined),
		};
		sharesService = {
			shareForApplication: jest.fn().mockResolvedValue(undefined),
		};
		service = new ApplicationService(
			applicationModel as never,
			conversationModel as never,
			listingService as never,
			{} as never,
			conversationAccessService as never,
			sharesService as never,
			{} as never,
			{} as never,
			{} as never,
		);
	});

	it("rejects a new application when a required document is missing", async () => {
		applicationModel.findOne.mockReturnValue({
			exec: jest.fn().mockResolvedValue(null),
		});
		listingService.findPublishedListingById.mockResolvedValue({
			...listing,
			requirements: [
				{
					name: "Identification",
					desc: "National ID or Passport",
					required: true,
				},
			],
		});

		await expect(service.create(listingId.toString(), user)).rejects.toThrow(
			"Missing required documents: Identification",
		);
		expect(conversationModel.create).not.toHaveBeenCalled();
	});

	it("does not ask for a guarantor when the listing's criterion is \"No guarantor needed\"", async () => {
		applicationModel.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });
		listingService.findPublishedListingById.mockResolvedValue({
			...listing,
			criteria: { guarantor: "NONE" },
			requirements: [{ name: "Guarantor", desc: "UK guarantor", required: true }],
		});
		conversationModel.create.mockResolvedValue({ _id: conversationId });
		applicationModel.create.mockResolvedValue(documentFrom({ _id: applicationId, listing: listingId, owner: userId, applicants: [userId] }));

		await expect(service.create(listingId.toString(), user)).resolves.toBeDefined();
		expect(applicationModel.create).toHaveBeenCalled();
	});

	it("refuses to apply to a property another household has already accepted (409)", async () => {
		applicationModel.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });
		applicationModel.exists.mockResolvedValue({ _id: new Types.ObjectId() });

		const applying = service.create(listingId.toString(), user);
		await expect(applying).rejects.toThrow(ConflictException);
		await expect(applying).rejects.toThrow("Another household has already accepted this property.");
		expect(applicationModel.exists.mock.calls[0][0]).toEqual({
			listing: listingId,
			stage: { $in: [ApplicationStage.ACCEPTED, ApplicationStage.SIGNED] },
		});
		expect(conversationModel.create).not.toHaveBeenCalled();
	});

	it("refuses to send an application once another household has accepted the property (409)", async () => {
		applicationModel.findById.mockReturnValue({
			lean: () => ({ exec: jest.fn().mockResolvedValue({ _id: applicationId, listing: listingId, stage: ApplicationStage.NOT_SENT }) }),
		});
		applicationModel.exists.mockResolvedValue({ _id: new Types.ObjectId() });

		const sending = service.send(applicationId.toString());
		await expect(sending).rejects.toThrow(ConflictException);
		await expect(sending).rejects.toThrow("Another household has already accepted this property.");
		expect(applicationModel.findOneAndUpdate).not.toHaveBeenCalled();
	});

	it("rejects applications for listings that are not published and verified", async () => {
		listingService.findPublishedListingById.mockRejectedValue(
			new NotFoundException("Listing not found"),
		);

		await expect(service.create(listingId.toString(), user)).rejects.toThrow(
			"Listing not found",
		);
		expect(applicationModel.findOne).not.toHaveBeenCalled();
		expect(conversationModel.create).not.toHaveBeenCalled();
	});

	it("returns the existing application without creating another chat", async () => {
		const existing = documentFrom({
			_id: applicationId,
			listing: listingId,
			owner: userId,
			conversation: conversationId,
			applicants: [userId],
			landlord: landlordId,
		});
		applicationModel.findOne.mockReturnValue({
			exec: jest.fn().mockResolvedValue(existing),
		});

		const result = await service.create(listingId.toString(), user);

		expect(result._id).toBe(applicationId.toString());
		expect(conversationModel.create).not.toHaveBeenCalled();
		expect(applicationModel.create).not.toHaveBeenCalled();
	});

	it("refuses to return an existing application once another household has accepted the property (409)", async () => {
		const existing = documentFrom({
			_id: applicationId,
			listing: listingId,
			owner: userId,
			conversation: conversationId,
			applicants: [userId],
			landlord: landlordId,
		});
		applicationModel.findOne.mockReturnValue({ exec: jest.fn().mockResolvedValue(existing) });
		applicationModel.exists.mockResolvedValue({ _id: new Types.ObjectId() });

		await expect(service.create(listingId.toString(), user)).rejects.toThrow(ConflictException);
		expect(applicationModel.exists.mock.calls[0][0]).toEqual({
			_id: { $ne: applicationId },
			listing: listingId,
			stage: { $in: [ApplicationStage.ACCEPTED, ApplicationStage.SIGNED] },
		});
	});

	it("creates one keyed application and one conversation", async () => {
		applicationModel.findOne.mockReturnValue({
			exec: jest.fn().mockResolvedValue(null),
		});
		conversationModel.create.mockResolvedValue({ _id: conversationId });
		applicationModel.create.mockResolvedValue(
			documentFrom({
				_id: applicationId,
				listing: listingId,
				owner: userId,
				conversation: conversationId,
				applicants: [userId],
				landlord: landlordId,
			}),
		);

		await service.create(listingId.toString(), user);

		expect(conversationModel.create).toHaveBeenCalledTimes(1);
		expect(applicationModel.create).toHaveBeenCalledWith(
			expect.objectContaining({
				applicationKey: `${listingId.toString()}:${userId.toString()}`,
			}),
		);
	});

	it("returns the winner and removes its unused chat when requests race", async () => {
		const winner = documentFrom({
			_id: applicationId,
			listing: listingId,
			owner: userId,
			conversation: conversationId,
			applicants: [userId],
			landlord: landlordId,
		});
		applicationModel.findOne
			.mockReturnValueOnce({ exec: jest.fn().mockResolvedValue(null) })
			.mockReturnValueOnce({ exec: jest.fn().mockResolvedValue(winner) });
		conversationModel.create.mockResolvedValue({ _id: conversationId });
		applicationModel.create.mockRejectedValue({ code: 11000 });

		const result = await service.create(listingId.toString(), user);

		expect(result._id).toBe(applicationId.toString());
		expect(conversationModel.deleteOne).toHaveBeenCalledWith({
			_id: conversationId,
		});
	});

	it("returns a linked application to an authorized conversation participant", async () => {
		applicationModel.findOne.mockReturnValue({
			exec: jest.fn().mockResolvedValue(documentFrom({
				_id: applicationId,
				listing: {
					_id: listingId,
					propertyTitle: "Market Street Flat",
					registerOfTitleKey: "private-title-key",
					registrationNumber: "private-registration",
					likedBy: [userId],
				},
				conversation: conversationId,
				owner: userId,
				applicants: [userId],
				landlord: landlordId,
			})),
		});

		const result = await service.getByConversation(
			conversationId.toString(),
			userId.toString(),
		);

		expect(conversationAccessService.assertCanAccess).toHaveBeenCalledWith(
			conversationId.toString(),
			userId.toString(),
		);
		expect(result.listing.registerOfTitleKey).toBeUndefined();
		expect(result.listing.registrationNumber).toBeUndefined();
		expect(result.listing.likedBy).toBeUndefined();
	});

	it("does not return a linked application to a conversation outsider", async () => {
		applicationModel.findOne.mockReturnValue({
			exec: jest.fn().mockResolvedValue(documentFrom({
				_id: applicationId,
				listing: listingId,
				conversation: conversationId,
				owner: userId,
				applicants: [userId],
				landlord: landlordId,
			})),
		});
		conversationAccessService.assertCanAccess.mockRejectedValue(
			new ForbiddenException("You are not a member of this conversation"),
		);

		await expect(service.getByConversation(
			conversationId.toString(),
			new Types.ObjectId().toString(),
		)).rejects.toBeInstanceOf(ForbiddenException);
	});

	describe("join", () => {
		const VALID_INVITE = "a".repeat(64);

		function mockApplication(overrides: Record<string, unknown> = {}) {
			applicationModel.findById.mockResolvedValue({
				_id: applicationId,
				conversation: conversationId,
				stage: ApplicationStage.NOT_SENT,
				inviteTokenHash: hashToken(VALID_INVITE),
				inviteTokenExpires: new Date(Date.now() + 60_000),
				...overrides,
			});
			const stage = (overrides.stage ?? ApplicationStage.NOT_SENT) as ApplicationStage;
			applicationModel.findOneAndUpdate.mockImplementation((filter: any) => Promise.resolve(
				filter.stage.$in.includes(stage) ? { _id: applicationId, stage } : null,
			));
			conversationModel.updateOne.mockReturnValue({
				exec: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
			});
		}

		it("adds a joined applicant to both the application and conversation", async () => {
			const joinedUserId = new Types.ObjectId();
			mockApplication();

			await service.join(
				applicationId.toString(),
				joinedUserId.toString(),
				VALID_INVITE,
			);

			expect(conversationModel.updateOne).toHaveBeenCalledWith(
				{ _id: conversationId },
				{ $addToSet: { users: joinedUserId } },
			);
		});

		it("refuses to join on the application id alone", async () => {
			mockApplication();

			// The id travels in shareable chat URLs, so knowing it must not be
			// enough to join and read the conversation.
			await expect(service.join(
				applicationId.toString(),
				new Types.ObjectId().toString(),
				"b".repeat(64),
			)).rejects.toBeInstanceOf(ForbiddenException);
			expect(conversationModel.updateOne).not.toHaveBeenCalled();
		});

		it("refuses an expired invite", async () => {
			mockApplication({ inviteTokenExpires: new Date(Date.now() - 1) });

			await expect(service.join(
				applicationId.toString(),
				new Types.ObjectId().toString(),
				VALID_INVITE,
			)).rejects.toBeInstanceOf(ForbiddenException);
			expect(conversationModel.updateOne).not.toHaveBeenCalled();
		});

		it("lets an invited user join after the application has been sent", async () => {
			const joinedUserId = new Types.ObjectId();
			mockApplication({ stage: ApplicationStage.SENT });

			await service.join(
				applicationId.toString(),
				joinedUserId.toString(),
				VALID_INVITE,
			);

			expect(conversationModel.updateOne).toHaveBeenCalledWith(
				{ _id: conversationId },
				{ $addToSet: { users: joinedUserId } },
			);
			// The landlord already has the group's documents; the newcomer's follow.
			expect(sharesService.shareForApplication).toHaveBeenCalledWith(
				expect.objectContaining({ ownerIds: [joinedUserId.toString()], application: applicationId }),
			);
		});

		it("shares the newcomer's documents once a viewing is booked", async () => {
			const joinedUserId = new Types.ObjectId();
			mockApplication({ stage: ApplicationStage.VIEWED });
			await service.join(applicationId.toString(), joinedUserId.toString(), VALID_INVITE);
			expect(sharesService.shareForApplication).toHaveBeenCalledWith(
				expect.objectContaining({ ownerIds: [joinedUserId.toString()] }),
			);
		});

		it("refuses to change the household once an offer is made", async () => {
			mockApplication({ stage: ApplicationStage.OFFERED });
			await expect(service.join(applicationId.toString(), new Types.ObjectId().toString(), VALID_INVITE))
				.rejects.toBeInstanceOf(BadRequestException);
			expect(conversationModel.updateOne).not.toHaveBeenCalled();
		});

		it("refuses when no invite has ever been issued", async () => {
			mockApplication({ inviteTokenHash: undefined, inviteTokenExpires: undefined });

			await expect(service.join(
				applicationId.toString(),
				new Types.ObjectId().toString(),
				VALID_INVITE,
			)).rejects.toBeInstanceOf(ForbiddenException);
			expect(conversationModel.updateOne).not.toHaveBeenCalled();
		});
	});
	describe("createInvite", () => {
		it("mints an invite after the application has been sent", async () => {
			applicationModel.findOneAndUpdate.mockResolvedValue({ _id: applicationId });

			const { inviteToken } = await service.createInvite(applicationId.toString());

			expect(inviteToken).toHaveLength(64);
			const [filter, update] = applicationModel.findOneAndUpdate.mock.calls[0];
			expect(filter).toEqual({ _id: applicationId.toString() });
			expect(update.$set.inviteTokenHash).toBe(hashToken(inviteToken));
		});

		it("reports a missing application", async () => {
			applicationModel.findOneAndUpdate.mockResolvedValue(null);

			await expect(
				service.createInvite(applicationId.toString()),
			).rejects.toBeInstanceOf(NotFoundException);
		});
	});

	describe("leave", () => {
		const memberId = new Types.ObjectId();

		function mockApplication(overrides: Record<string, unknown> = {}) {
			applicationModel.findById.mockResolvedValue({
				_id: applicationId,
				conversation: conversationId,
				owner: userId,
				applicants: [userId, memberId],
				...overrides,
			});
			applicationModel.findOneAndUpdate.mockResolvedValue({ _id: applicationId });
			conversationModel.updateOne.mockReturnValue({
				exec: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
			});
		}

		it("removes a member from the application and its conversation", async () => {
			mockApplication();

			await service.leave(applicationId.toString(), memberId.toString());

			expect(applicationModel.findOneAndUpdate).toHaveBeenCalledWith(
				{ _id: applicationId.toString() },
				{ $pull: { applicants: memberId } },
			);
			expect(conversationModel.updateOne).toHaveBeenCalledWith(
				{ _id: conversationId },
				{ $pull: { users: memberId } },
			);
		});

		it("does not let the creator leave their own application", async () => {
			mockApplication();

			await expect(
				service.leave(applicationId.toString(), userId.toString()),
			).rejects.toBeInstanceOf(BadRequestException);
			expect(conversationModel.updateOne).not.toHaveBeenCalled();
		});
	});
});

describe("ApplicationService.getAllByListing", () => {
	const doc = (plain: any) => ({ ...plain, toObject: () => plain });
	const listing = new Types.ObjectId();
	const conversation = new Types.ObjectId();
	const landlord = new Types.ObjectId();
	const applicant = {
		_id: new Types.ObjectId(),
		name: "Emma Smith",
		email: "emma@example.com",
		password: "$2a$10$hashedsecret",
		refreshToken: "should-not-leak"
	};

	const query = {
		populate: jest.fn().mockReturnThis(),
		sort: jest.fn().mockReturnThis(),
		exec: jest.fn().mockResolvedValue([
			doc({
				_id: new Types.ObjectId(),
				listing,
				conversation,
				landlord,
				applicants: [applicant],
				owner: applicant._id,
				createdAt: new Date(),
				stage: ApplicationStage.SENT
			})
		])
	};
	const applicationModel = { find: jest.fn().mockReturnValue(query) };

	const listingService = { findListingById: jest.fn().mockResolvedValue({ numOfPeople: 1 }) };
	const sharesService = { activeOwnersFor: jest.fn().mockResolvedValue(new Map()) };
	const service = new ApplicationService(
		applicationModel as never,
		{} as never,
		listingService as never,
		{} as never,
		{} as never,
		sharesService as never,
		{} as never,
		{} as never,
		{} as never
	);

	it("only returns applications the student has actually sent", async () => {
		await service.getAllByListing(listing.toHexString());

		const [filter] = applicationModel.find.mock.calls[0];
		expect(filter.listing).toBe(listing.toHexString());
		// Everything from SENT through SIGNED; only drafts stay hidden.
		expect(filter.stage).toEqual({ $ne: "NOT_SENT" });
	});

	it("exposes populated applicants safely and keeps applicant ids intact", async () => {
		const [application] = await service.getAllByListing(listing.toHexString());

		expect(query.populate).toHaveBeenCalledWith({
			path: "applicants",
			select: "name email profilePicUrl documents universityDetails"
		});
		// Ids must survive serialisation as the *same* ids (class-transformer
		// otherwise re-instantiates ObjectIds into fresh random ones).
		expect(application.applicants).toEqual([applicant._id.toHexString()]);
		expect(application.owner).toBe(applicant._id.toHexString());
		expect(application.landlord).toBe(landlord.toHexString());

		const [user] = application.applicantUsers! as any[];
		expect(user._id).toBe(applicant._id.toHexString());
		expect(user.name).toBe("Emma Smith");
		expect(user.email).toBe("emma@example.com");
		expect(user.password).toBeUndefined();
		expect(user.refreshToken).toBeUndefined();

		expect(application.conversation._id).toBe(conversation.toHexString());
		expect(application.stage).toBe(ApplicationStage.SENT);
	});
});

describe("ApplicationService pipeline", () => {
	const listingId = new Types.ObjectId();
	const landlordId = new Types.ObjectId();
	const studentId = new Types.ObjectId();
	const applicationId = new Types.ObjectId();
	const future = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
	const otherSlot = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000);

	let applicationModel: Record<string, jest.Mock>;
	let listingService: { findListingById: jest.Mock };
	let notifications: { notifyMany: jest.Mock; notify: jest.Mock };
	let paymentModel: Record<string, jest.Mock>;
	let service: ApplicationService;

	const exec = (value: unknown) => ({ exec: jest.fn().mockResolvedValue(value), populate: jest.fn().mockReturnThis() });

	beforeEach(() => {
		applicationModel = {
			findById: jest.fn(),
			findOneAndUpdate: jest.fn(),
			countDocuments: jest.fn().mockResolvedValue(0),
			exists: jest.fn().mockResolvedValue(null),
			updateOne: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({}) }),
		};
		paymentModel = {
			deleteMany: jest.fn().mockResolvedValue({}),
			updateMany: jest.fn().mockResolvedValue({ matchedCount: 0 }),
			find: jest.fn().mockReturnValue({ lean: () => ({ exec: jest.fn().mockResolvedValue([]) }) }),
			insertMany: jest.fn().mockResolvedValue([]),
		};
		listingService = {
			findListingById: jest.fn().mockResolvedValue({
				_id: listingId,
				landlord: landlordId,
				propertyTitle: "Cotham Flat",
				holdingDeposit: 150,
				viewingSlots: [future],
			}),
		};
		notifications = { notifyMany: jest.fn().mockResolvedValue(undefined), notify: jest.fn() };
		service = new ApplicationService(
			applicationModel as never,
			{} as never,
			listingService as never,
			{} as never,
			{} as never,
			{} as never,
			{ createFromApplication: jest.fn().mockResolvedValue({ _id: new Types.ObjectId() }) } as never,
			notifications as never,
			paymentModel as never,
		);
	});

	function stored(stage: ApplicationStage, extra: Record<string, unknown> = {}) {
		const value: Record<string, any> = {
			_id: applicationId,
			listing: listingId,
			landlord: landlordId,
			applicants: [studentId],
			stage,
			save: jest.fn().mockResolvedValue(undefined),
			...extra,
		};
		value.toObject = () => value;
		return value;
	}

	/** Stubs the listing queue: entries in the order they applied. */
	function queue(...entries: { id: Types.ObjectId; qualified: boolean; stage?: ApplicationStage; offerExpiresAt?: Date; offerExpiredAt?: Date }[]) {
		const all = entries.map(entry => ({
			id: entry.id.toString(),
			qualified: entry.qualified,
			members: [],
			application: { _id: entry.id, stage: entry.stage ?? ApplicationStage.SENT, offerExpiresAt: entry.offerExpiresAt ?? null, offerExpiredAt: entry.offerExpiredAt ?? null },
		}));
		return jest.spyOn(service as any, "queueFor").mockResolvedValue({ all, qualified: all.filter(entry => entry.qualified), listing: null });
	}

	describe("offer queue rules", () => {
		const earlier = new Types.ObjectId();
		beforeEach(() => {
			applicationModel.findById.mockReturnValue(exec(stored(ApplicationStage.VIEWED)));
			applicationModel.findOneAndUpdate.mockReturnValue(exec(stored(ApplicationStage.OFFERED, { offeredAt: new Date() })));
		});

		it("refuses a household whose passports are not all complete", async () => {
			queue({ id: applicationId, qualified: false });
			await expect(service.offer(applicationId.toString())).rejects.toThrow("Only a qualified household");
			expect(applicationModel.findOneAndUpdate).not.toHaveBeenCalled();
		});

		it("refuses to skip an earlier qualified household", async () => {
			queue({ id: new Types.ObjectId(), qualified: false }, { id: earlier, qualified: true }, { id: applicationId, qualified: true });
			await expect(service.offer(applicationId.toString())).rejects.toThrow("first qualified household");
		});

		it("skips an earlier household whose offer lapsed", async () => {
			queue({ id: earlier, qualified: true, offerExpiredAt: new Date(Date.now() - 1000) }, { id: applicationId, qualified: true });
			await expect(service.offer(applicationId.toString())).resolves.toBeDefined();
		});

		it("refuses to approve the second household in the queue", async () => {
			queue({ id: earlier, qualified: true }, { id: applicationId, qualified: true });
			await expect(service.approve(applicationId.toString())).rejects.toThrow(ConflictException);
			expect(applicationModel.findOneAndUpdate).not.toHaveBeenCalled();
		});

		it("refuses to approve an unqualified household", async () => {
			queue({ id: applicationId, qualified: false });
			await expect(service.approve(applicationId.toString())).rejects.toThrow("Only a qualified household");
		});

		it("approves the first qualified household in the queue", async () => {
			queue({ id: applicationId, qualified: true });
			applicationModel.findOneAndUpdate.mockReturnValue(exec(stored(ApplicationStage.ACCEPTED)));
			await expect(service.approve(applicationId.toString())).resolves.toHaveProperty("tenancy");
			expect(applicationModel.findOneAndUpdate.mock.calls[0][0].stage).toBe(ApplicationStage.VIEWED);
		});

		it("refuses to approve or offer once another household has accepted (no double let)", async () => {
			queue({ id: applicationId, qualified: true });
			applicationModel.exists.mockResolvedValue({ _id: new Types.ObjectId() });
			await expect(service.approve(applicationId.toString())).rejects.toThrow("already accepted");
			await expect(service.offer(applicationId.toString())).rejects.toThrow(ConflictException);
			expect(applicationModel.exists.mock.calls[0][0].stage).toEqual({ $in: [ApplicationStage.ACCEPTED, ApplicationStage.SIGNED] });
			expect(applicationModel.findOneAndUpdate).not.toHaveBeenCalled();
		});

		it("drops unpaid holding deposits when approving straight from an offer", async () => {
			queue({ id: applicationId, qualified: true });
			applicationModel.findById.mockReturnValue(exec(stored(ApplicationStage.OFFERED, { offerExpiresAt: future })));
			applicationModel.findOneAndUpdate.mockReturnValue(exec(stored(ApplicationStage.ACCEPTED)));
			await service.approve(applicationId.toString());
			expect(paymentModel.deleteMany).toHaveBeenCalledWith(expect.objectContaining({ application: applicationId, kind: "HOLDING_DEPOSIT", status: { $ne: "PAID" } }));
		});

		it("refuses a second open offer on the same listing", async () => {
			queue({ id: earlier, qualified: true, stage: ApplicationStage.OFFERED, offerExpiresAt: future }, { id: applicationId, qualified: true });
			await expect(service.offer(applicationId.toString())).rejects.toThrow("already holds an open offer");
		});
	});

	it("sets a 15 day deadline and copies the holding deposit when an offer is made", async () => {
		queue({ id: applicationId, qualified: true });
		applicationModel.findById.mockReturnValue(exec(stored(ApplicationStage.VIEWED)));
		applicationModel.findOneAndUpdate.mockReturnValue(exec(stored(ApplicationStage.OFFERED, { offeredAt: new Date() })));

		await service.offer(applicationId.toString());

		const [filter, update] = applicationModel.findOneAndUpdate.mock.calls[0];
		expect(filter.stage).toBe(ApplicationStage.VIEWED);
		const { offeredAt, offerExpiresAt, holdingDeposit, stage } = update.$set;
		expect(stage).toBe(ApplicationStage.OFFERED);
		expect(holdingDeposit).toBe(150);
		expect(offerExpiresAt.getTime() - offeredAt.getTime()).toBe(15 * 24 * 60 * 60 * 1000);
		expect(notifications.notifyMany).toHaveBeenCalled();
		// One holding-deposit payment per member, in pence. Seek's fee is on rent only.
		const [docs] = paymentModel.insertMany.mock.calls[0];
		expect(docs).toHaveLength(1);
		expect(docs[0]).toMatchObject({ kind: "HOLDING_DEPOSIT", amount: 15000, seekFee: 0, payout: 15000 });
	});

	it("keeps one payable holding deposit per member when an offer is renewed", async () => {
		queue({ id: applicationId, qualified: true });
		applicationModel.findById.mockReturnValue(exec(stored(ApplicationStage.VIEWED)));
		applicationModel.findOneAndUpdate.mockReturnValue(exec(stored(ApplicationStage.OFFERED, { offeredAt: new Date() })));
		const withSession = { _id: new Types.ObjectId(), tenant: studentId, amount: 15000, status: "SCHEDULED", providerRef: "cs_test_old" };
		const duplicate = { _id: new Types.ObjectId(), tenant: studentId, amount: 15000, status: "SCHEDULED", providerRef: null };
		paymentModel.find.mockReturnValue({ lean: () => ({ exec: jest.fn().mockResolvedValue([duplicate, withSession]) }) });
		paymentModel.updateOne = jest.fn().mockResolvedValue({});

		await service.offer(applicationId.toString());

		expect(paymentModel.deleteMany).toHaveBeenCalledWith(expect.objectContaining({ _id: { $in: [duplicate._id] } }));
		expect(paymentModel.updateOne.mock.calls[0][0]._id).toBe(withSession._id);
		expect(paymentModel.updateOne.mock.calls[0][1].$set).not.toHaveProperty("providerRef");
		expect(paymentModel.insertMany).not.toHaveBeenCalled();
	});

	it("puts a lapsed offer back in the queue and tells the household", async () => {
		const lapsed = stored(ApplicationStage.OFFERED, { offerExpiresAt: new Date(Date.now() - 1000), viewingAt: future });
		applicationModel.find = jest.fn()
			.mockReturnValueOnce({ exec: jest.fn().mockResolvedValue([lapsed]) })
			.mockReturnValue({
				populate: jest.fn().mockReturnThis(),
				sort: jest.fn().mockReturnThis(),
				lean: jest.fn().mockReturnThis(),
				exec: jest.fn().mockResolvedValue([]),
			});
		applicationModel.findOneAndUpdate.mockReturnValue(exec(lapsed));

		await expect(service.expireOffers()).resolves.toBe(1);

		const [, update] = applicationModel.findOneAndUpdate.mock.calls[0];
		expect(update.$set).toMatchObject({ stage: ApplicationStage.VIEWED, offerExpiresAt: null, offerExpiredAt: lapsed.offerExpiresAt });
		expect(paymentModel.deleteMany).toHaveBeenCalledWith(expect.objectContaining({ kind: "HOLDING_DEPOSIT", status: { $ne: "PAID" } }));
		expect(notifications.notifyMany.mock.calls[0][0][0].kind).toBe("OFFER_EXPIRED");
	});

	it("flags a paid holding deposit for refund and tells the landlord when an offer lapses", async () => {
		const lapsed = stored(ApplicationStage.OFFERED, { offerExpiresAt: new Date(Date.now() - 1000) });
		applicationModel.find = jest.fn()
			.mockReturnValueOnce({ exec: jest.fn().mockResolvedValue([lapsed]) })
			.mockReturnValue({
				populate: jest.fn().mockReturnThis(),
				sort: jest.fn().mockReturnThis(),
				lean: jest.fn().mockReturnThis(),
				exec: jest.fn().mockResolvedValue([]),
			});
		applicationModel.findOneAndUpdate.mockReturnValue(exec(lapsed));
		paymentModel.updateMany.mockResolvedValue({ matchedCount: 1 });

		await service.expireOffers();

		expect(paymentModel.updateMany).toHaveBeenCalledWith(
			{ application: applicationId, kind: "HOLDING_DEPOSIT" },
			{ $set: { refundDue: true } },
		);
		const [refund] = notifications.notify.mock.calls[0];
		expect(refund.user).toBe(landlordId);
		expect(refund.body).toContain("within 7 days");
	});

	it("does not offer twice while the first offer is still open", async () => {
		applicationModel.findById.mockReturnValue(
			exec(stored(ApplicationStage.OFFERED, { offerExpiresAt: future })),
		);
		await expect(service.offer(applicationId.toString())).rejects.toThrow(BadRequestException);
	});

	it("only lets a household accept an offer that has not expired", async () => {
		applicationModel.findOneAndUpdate.mockReturnValue(exec(null));
		applicationModel.findById.mockReturnValue({ lean: () => exec(stored(ApplicationStage.OFFERED)) });
		await expect(service.acceptOffer(applicationId.toString())).rejects.toThrow("may have expired");
		const [filter] = applicationModel.findOneAndUpdate.mock.calls[0];
		expect(filter.stage).toBe(ApplicationStage.OFFERED);
		expect(filter.offerExpiresAt.$gt).toBeInstanceOf(Date);
	});

	it("refuses to accept an offer once another household has accepted the property (no double let)", async () => {
		applicationModel.findById.mockReturnValue({ lean: () => exec(stored(ApplicationStage.OFFERED, { offerExpiresAt: future })) });
		applicationModel.exists.mockResolvedValue({ _id: new Types.ObjectId() });
		const accepting = service.acceptOffer(applicationId.toString());
		await expect(accepting).rejects.toThrow(ConflictException);
		await expect(accepting).rejects.toThrow("Another household has already accepted this property");
		expect(applicationModel.findOneAndUpdate).not.toHaveBeenCalled();
	});

	it("stores the reason and tells the household when an application is declined", async () => {
		applicationModel.findOneAndUpdate.mockReturnValue(
			exec(stored(ApplicationStage.REJECTED, { rejectReason: "Room filled" })),
		);
		await service.reject(applicationId.toString(), "  Room filled ");
		const [, update] = applicationModel.findOneAndUpdate.mock.calls[0];
		expect(update.$set).toEqual({ stage: ApplicationStage.REJECTED, rejectReason: "Room filled" });
		expect(notifications.notifyMany.mock.calls[0][0][0].body).toContain("Room filled");
	});

	it("on decline drops unpaid holding deposits, flags paid ones for refund and tells the landlord", async () => {
		applicationModel.findOneAndUpdate.mockReturnValue(
			exec(stored(ApplicationStage.REJECTED, { listing: { _id: listingId, propertyTitle: "Cotham Flat" } })),
		);
		paymentModel.updateMany.mockResolvedValue({ matchedCount: 1 });
		await service.reject(applicationId.toString());
		expect(paymentModel.deleteMany).toHaveBeenCalledWith(expect.objectContaining({ application: applicationId, status: { $ne: "PAID" } }));
		expect(paymentModel.updateMany).toHaveBeenCalledWith(
			{ application: applicationId, kind: "HOLDING_DEPOSIT" },
			{ $set: { refundDue: true } },
		);
		const [refund] = notifications.notify.mock.calls[0];
		expect(refund.user).toBe(landlordId);
		expect(refund.body).toContain("within 7 days");
		expect(refund.link).not.toContain("/student");
	});

	it("on decline flags for refund a deposit Stripe took just before the decline (webhook not in yet)", async () => {
		const previousKey = process.env.STRIPE_SECRET_KEY;
		process.env.STRIPE_SECRET_KEY = "sk_test_x";
		const expire = jest.spyOn(StripeClient.prototype, "expireCheckoutSession").mockRejectedValue(new StripeApiError("not open", 400));
		const retrieve = jest.spyOn(StripeClient.prototype, "retrieveCheckoutSession").mockResolvedValue({ status: "complete", payment_status: "paid" } as never);
		try {
			const paying = { _id: new Types.ObjectId(), providerRef: "cs_test_paid" };
			paymentModel.find.mockReturnValue({ lean: () => ({ exec: jest.fn().mockResolvedValue([paying]) }) });
			applicationModel.findOneAndUpdate.mockReturnValue(exec(stored(ApplicationStage.REJECTED)));
			paymentModel.updateMany.mockResolvedValue({ matchedCount: 1 });

			await service.reject(applicationId.toString());

			expect(paymentModel.deleteMany).toHaveBeenCalledWith(expect.objectContaining({ _id: { $nin: [paying._id] } }));
			const [filter, update] = paymentModel.updateMany.mock.calls[0];
			expect(filter).not.toHaveProperty("status");
			expect(update).toEqual({ $set: { refundDue: true } });
			expect(notifications.notify.mock.calls[0][0].user).toBe(landlordId);
		} finally {
			expire.mockRestore();
			retrieve.mockRestore();
			if (previousKey === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = previousKey;
		}
	});

	it("backs out a viewing booking that raced another household past the slot's capacity", async () => {
		const student = { _id: studentId, name: "Student" } as User;
		applicationModel.findById.mockReturnValue(exec(stored(ApplicationStage.SENT)));
		applicationModel.countDocuments.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
		await expect(service.scheduleViewing(applicationId.toString(), future.toISOString(), student)).rejects.toThrow("already booked");
		expect(applicationModel.updateOne).toHaveBeenCalledWith(
			{ _id: applicationId, viewingAt: future },
			{ $set: { viewingAt: null, stage: ApplicationStage.SENT } },
		);
		expect(notifications.notifyMany).not.toHaveBeenCalled();
	});

	it("sends the landlord a landlord link when a student books a viewing", async () => {
		const student = { _id: studentId, name: "Student" } as User;
		applicationModel.findById.mockReturnValue(exec(stored(ApplicationStage.SENT)));
		await service.scheduleViewing(applicationId.toString(), future.toISOString(), student);
		const [inputs] = notifications.notifyMany.mock.calls[0];
		const toLandlord = inputs.find((input: any) => input.user === landlordId);
		expect(toLandlord.link).not.toContain("/student");
		expect(toLandlord.target.listing).toBe(listingId.toString());
	});

	it("refuses a viewing time the landlord did not offer, but lets the landlord move it", async () => {
		const student = { _id: studentId, name: "Student" } as User;
		const landlord = { _id: landlordId, name: "Landlord" } as User;
		applicationModel.findById.mockImplementation(() => exec(stored(ApplicationStage.SENT)));

		await expect(
			service.scheduleViewing(applicationId.toString(), otherSlot.toISOString(), student),
		).rejects.toThrow("not offered");
		await expect(
			service.scheduleViewing(applicationId.toString(), otherSlot.toISOString(), landlord),
		).resolves.toBeDefined();
	});

	it("moves a sent application to VIEWED once a slot is picked, and refuses a slot another household holds", async () => {
		const student = { _id: studentId, name: "Student" } as User;
		const record = stored(ApplicationStage.SENT);
		applicationModel.findById.mockReturnValue(exec(record));
		await service.scheduleViewing(applicationId.toString(), future.toISOString(), student);
		expect(record.stage).toBe(ApplicationStage.VIEWED);

		applicationModel.countDocuments.mockResolvedValue(1);
		applicationModel.findById.mockReturnValue(exec(stored(ApplicationStage.SENT)));
		await expect(
			service.scheduleViewing(applicationId.toString(), future.toISOString(), student),
		).rejects.toThrow("already booked");

		// A slot that holds two households takes a second booking.
		listingService.findListingById.mockResolvedValueOnce({
			_id: listingId, landlord: landlordId, viewingSlots: [future], viewingSlotCapacity: 2,
		});
		applicationModel.findById.mockReturnValue(exec(stored(ApplicationStage.SENT)));
		await expect(
			service.scheduleViewing(applicationId.toString(), future.toISOString(), student),
		).resolves.toBeDefined();
	});
});

describe("ApplicationService.getAllMyApplications", () => {
	const listingId = new Types.ObjectId();
	const applicationId = new Types.ObjectId();
	const own = { _id: applicationId, listing: listingId, applicants: [], stage: ApplicationStage.SENT };
	let service: ApplicationService;
	let queueFor: jest.SpyInstance;

	function setup(qualified: boolean) {
		const chain = { populate: jest.fn().mockReturnThis(), sort: jest.fn().mockReturnThis(), exec: jest.fn().mockResolvedValue([documentFrom({ ...own, listing: { _id: listingId } })]) };
		const applicationModel = {
			find: jest.fn().mockReturnValue(chain),
			findById: jest.fn().mockReturnValue({ populate: jest.fn().mockReturnThis(), lean: jest.fn().mockReturnThis(), exec: jest.fn().mockResolvedValue(own) }),
		};
		const listingService = { findListingById: jest.fn().mockResolvedValue({ _id: listingId }), viewingSlotAvailability: jest.fn().mockResolvedValue([]) };
		service = new ApplicationService(applicationModel as never, {} as never, listingService as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
		jest.spyOn(service as any, "householdEntry").mockReturnValue({ id: applicationId.toString(), qualified, readiness: qualified ? 100 : 50, criteria: [], members: [] });
		const earlier = { id: new Types.ObjectId().toString(), qualified: true };
		const mine = { id: applicationId.toString(), qualified: true };
		queueFor = jest.spyOn(service as any, "queueFor").mockResolvedValue({ all: [earlier, mine], qualified: [earlier, mine], listing: null });
	}

	it("does not load the listing's whole queue for a household that is not qualified", async () => {
		setup(false);
		const [dto] = await service.getAllMyApplications(new Types.ObjectId().toString());
		expect(queueFor).not.toHaveBeenCalled();
		expect(dto.queuePosition).toBeNull();
	});

	it("gives a qualified household its place in line", async () => {
		setup(true);
		const [dto] = await service.getAllMyApplications(new Types.ObjectId().toString());
		expect(queueFor).toHaveBeenCalledTimes(1);
		expect(dto.queuePosition).toBe(2);
		expect(dto.queueSize).toBe(2);
	});
});
