import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { ResolveFlagDto } from "./dto/resolve-flag.dto";
import { Types } from "mongoose";
import { FlagStatus } from "./enums/flag-status";
import { FlagsService } from "./flags.service";

describe("FlagsService", () => {
	it("returns moderation reports from the model", async () => {
		const reports = [{ _id: "flag-1" }];
		const flagModel = {
			find: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(reports) }),
			updateMany: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({}) })
		};
		const service = new FlagsService(flagModel as never, {} as never);

		await expect(service.getAll()).resolves.toBe(reports);
	});

	it("stores the flag and emails the admin, and a failed email does not fail the report", async () => {
		const stored = { _id: "flag-2", text: "spam" };
		const flagModel = { create: jest.fn().mockResolvedValue({ ...stored, toObject: () => stored }) };
		const userModel = { exists: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({ _id: "u" }) }) };
		const mail = { sendReportEmail: jest.fn().mockRejectedValue(new Error("mailgun down")) };
		const service = new FlagsService(flagModel as never, userModel as never, undefined, undefined, undefined, undefined, undefined, mail as never);
		jest.spyOn((service as any).logger, "error").mockImplementation(() => undefined);

		await expect(
			service.create(
				{ reportedUser: "64b64b64b64b64b64b64b64b", text: "spam", category: "OTHER" } as never,
				{ _id: "u", name: "Ann", email: "a@st-andrews.ac.uk" } as never
			)
		).resolves.toBe(stored);
		expect(mail.sendReportEmail).toHaveBeenCalledWith("Ann", "a@st-andrews.ac.uk", "[OTHER] spam", "user 64b64b64b64b64b64b64b64b");
	});

	it("lists only the caller's reports, newest first", async () => {
		const sort = jest.fn().mockReturnValue({ lean: () => ({ exec: jest.fn().mockResolvedValue([]) }) });
		const select = jest.fn().mockReturnValue({ sort });
		const updateMany = jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({}) });
		const flagModel = { find: jest.fn().mockReturnValue({ select }), updateMany };
		const service = new FlagsService(flagModel as never, {} as never);
		const me = "64b64b64b64b64b64b64b64b" as never;

		await service.findMine(me);
		expect(flagModel.find).toHaveBeenCalledWith({ createdBy: me });
		expect(sort).toHaveBeenCalledWith({ createdAt: -1 });
		// The AI triage is for Seek only, never shown to the reporter.
		expect(select).toHaveBeenCalledWith("-triage");
		// Reports older than 30 days that reached no threshold are closed first, with a fixed answer.
		expect(updateMany).toHaveBeenCalledWith(
			{ status: FlagStatus.UNDER_REVIEW, createdAt: { $lt: expect.any(Date) } },
			{ $set: expect.objectContaining({ status: FlagStatus.NO_ACTION, supportResponse: expect.stringContaining("30 days") }) }
		);
	});

	it("GET /flags/:id never returns the AI triage", async () => {
		const select = jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({ _id: "f" }) });
		const flagModel = {
			findById: jest.fn().mockReturnValue({ select }),
			updateMany: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({}) })
		};
		const service = new FlagsService(flagModel as never, {} as never);
		await service.findOne(new Types.ObjectId().toString());
		expect(select).toHaveBeenCalledWith("-triage");
	});

	describe("automatic triage and suspension", () => {
		const reported = "64b64b64b64b64b64b64b64b";
		const exec = <T>(value: T) => ({ exec: jest.fn().mockResolvedValue(value) });
		const reporter = { _id: new Types.ObjectId(), email: "r@st-andrews.ac.uk", isVerified: true };

		const setup = (
			opts: { verifiedReporters?: number; linked?: boolean; severeFromReporter?: number; reportedSpoke?: boolean; severeReporters?: (verified: Types.ObjectId[]) => Types.ObjectId[] } = {}
		) => {
			// Verified reporters; the first one is the caller of create().
			const verified = [reporter._id, ...Array.from({ length: Math.max(0, (opts.verifiedReporters ?? 1) - 1) }, () => new Types.ObjectId())];
			const stored = { _id: new Types.ObjectId(), toObject: () => ({}) };
			const flagModel = {
				create: jest.fn().mockResolvedValue(stored),
				updateOne: jest.fn().mockReturnValue(exec({})),
				updateMany: jest.fn().mockReturnValue(exec({})),
				// Open severe reports come from the caller only, unless severeReporters says otherwise.
				distinct: jest.fn((_field: string, filter: Record<string, unknown>) =>
					exec("triage.severity" in filter ? (opts.severeReporters?.(verified) ?? [reporter._id]) : [new Types.ObjectId()])
				),
				countDocuments: jest.fn().mockReturnValue(exec(opts.severeFromReporter ?? 1)),
				findByIdAndUpdate: jest.fn().mockReturnValue(exec({ reportedUser: new Types.ObjectId(reported) }))
			};
			const userModel = {
				exists: jest.fn().mockReturnValue(exec({ _id: reported })),
				distinct: jest.fn().mockReturnValue(exec(opts.verifiedReporters === 0 ? [] : verified)),
				// Owners whose team holds a reporter; none by default.
				find: jest.fn().mockReturnValue({ lean: () => exec([]) }),
				updateOne: jest.fn().mockReturnValue(exec({ modifiedCount: 1 }))
			};
			const listingModel = { updateMany: jest.fn().mockReturnValue(exec({ matchedCount: 1 })), find: jest.fn().mockReturnValue(exec([])) };
			const notifications = { notifyMany: jest.fn().mockResolvedValue(undefined), notify: jest.fn().mockResolvedValue(true) };
			// Every verified reporter shares a conversation with the reported account unless linked is false.
			const conversationModel = { distinct: jest.fn().mockReturnValue(exec(opts.linked === false ? [] : [new Types.ObjectId(reported), ...verified])) };
			const tenancyModel = { find: jest.fn().mockReturnValue({ lean: () => exec([]) }) };
			// Conversations the reported account wrote in; none when reportedSpoke is false.
			const messageModel = { distinct: jest.fn().mockReturnValue(exec(opts.reportedSpoke === false ? [] : [new Types.ObjectId()])) };
			const service = new FlagsService(
				flagModel as never,
				userModel as never,
				listingModel as never,
				notifications as never,
				conversationModel as never,
				tenancyModel as never,
				messageModel as never
			);
			jest.spyOn((service as any).logger, "warn").mockImplementation(() => undefined);
			return { service, flagModel, userModel, listingModel, notifications, conversationModel, messageModel, verified };
		};
		const report = (text = "He asked me to wire the deposit before any viewing") =>
			({ reportedUser: reported, text, category: "SCAM" }) as never;

		it("without any AI, one scam report from a linked verified reporter is triaged severe but hides nothing (keywords cannot read intent)", async () => {
			const { service, flagModel, userModel, listingModel } = setup();
			await service.create(report("Total scam: he took my deposit and the flat does not exist"), reporter as never);

			expect(flagModel.updateOne).toHaveBeenCalledWith(
				expect.anything(),
				{ $set: { triage: { category: "FRAUD_SCAM", severity: "high", summary: "", provider: "rules" } } }
			);
			expect(userModel.updateOne).not.toHaveBeenCalled();
			expect(listingModel.updateMany).not.toHaveBeenCalled();
		});

		it("severe reports from 2 distinct linked verified reporters hide the listings without suspending", async () => {
			const { service, flagModel, userModel, listingModel } = setup({ verifiedReporters: 2, severeReporters: verified => verified });
			await service.create(report("Total scam: he took my deposit and the flat does not exist"), reporter as never);

			expect(flagModel.distinct).toHaveBeenCalledWith(
				"createdBy",
				expect.objectContaining({ status: FlagStatus.UNDER_REVIEW, "triage.severity": "high", createdAt: { $gte: expect.any(Date) } })
			);
			expect(userModel.updateOne).not.toHaveBeenCalled();
			expect(listingModel.updateMany).toHaveBeenCalledWith(
				expect.objectContaining({ isDraft: false }),
				{ $set: expect.objectContaining({ isVerified: false, moderationStatus: "NEEDS_CHANGES", lastUpdated: expect.any(Date) }) }
			);
			// Neutral reason: a landlord with one applicant must not learn who reported him.
			expect(listingModel.updateMany.mock.calls[0][1].$set.moderationReasons[0]).not.toMatch(/student|report/i);
		});

		it("does not count a second severe reporter who is unverified", async () => {
			const unverified = new Types.ObjectId();
			const { service, listingModel } = setup({ severeReporters: () => [reporter._id, unverified] });
			await service.create(report(), reporter as never);
			expect(listingModel.updateMany).not.toHaveBeenCalled();
		});

		it("does not count a second severe reporter who never dealt with the account", async () => {
			const { service, listingModel, conversationModel } = setup({ verifiedReporters: 2, severeReporters: verified => verified });
			conversationModel.distinct.mockReturnValue(exec([new Types.ObjectId(reported), reporter._id]));
			await service.create(report(), reporter as never);
			expect(listingModel.updateMany).not.toHaveBeenCalled();
		});

		it("hides the listings only once per reporter in 30 days, however often the same account reports", async () => {
			const { service, listingModel } = setup({ verifiedReporters: 2, severeReporters: verified => verified, severeFromReporter: 2 });
			await service.create(report(), reporter as never);
			expect(listingModel.updateMany).not.toHaveBeenCalled();
		});

		it("does not count a conversation the reported account never wrote in (applying alone creates one)", async () => {
			const { service, userModel, conversationModel } = setup({ verifiedReporters: 3, reportedSpoke: false });
			await service.create(report("Rude messages"), reporter as never);
			expect(conversationModel.distinct).not.toHaveBeenCalled();
			expect(userModel.updateOne).not.toHaveBeenCalled();
		});

		it("counts open reports only, so a lifted suspension is not undone by the next report", async () => {
			const { service, flagModel } = setup();
			await service.create(report("Rude messages"), reporter as never);
			expect(flagModel.distinct).toHaveBeenCalledWith("createdBy", expect.objectContaining({ status: FlagStatus.UNDER_REVIEW }));
		});

		it("ignores a severe report from someone who never dealt with the account", async () => {
			const { service, userModel, listingModel } = setup({ verifiedReporters: 3, linked: false });
			await service.create(report(), reporter as never);
			expect(userModel.updateOne).not.toHaveBeenCalled();
			expect(listingModel.updateMany).not.toHaveBeenCalled();
		});

		it("does nothing on a severe report from an unverified reporter", async () => {
			const { service, userModel, listingModel } = setup({ verifiedReporters: 0 });
			await service.create(report("He threatened me with a knife"), { ...reporter, isVerified: false } as never);
			expect(userModel.updateOne).not.toHaveBeenCalled();
			expect(listingModel.updateMany).not.toHaveBeenCalled();
		});

		it("suspends after reports from 3 distinct linked verified reporters in 30 days, whatever the report says", async () => {
			const { service, flagModel, userModel, listingModel, notifications } = setup({ verifiedReporters: 3 });
			await service.create(report("Rude messages"), reporter as never);
			expect(flagModel.updateOne).not.toHaveBeenCalled();
			expect(flagModel.distinct).toHaveBeenCalledWith("createdBy", expect.objectContaining({ createdAt: { $gte: expect.any(Date) } }));
			expect(userModel.updateOne).toHaveBeenCalledWith(
				expect.objectContaining({ suspendedAt: null }),
				{ $set: expect.objectContaining({ suspendedAt: expect.any(Date) }) }
			);
			expect(listingModel.updateMany).toHaveBeenCalled();
			expect(notifications.notifyMany).toHaveBeenCalled();
		});

		it("tells the landlord his listings went offline, and a new suspension after a lifted one notifies reporters again", async () => {
			const { service, userModel, notifications } = setup();
			await service.suspend(reported, "first");
			expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({
				user: new Types.ObjectId(reported), kind: "LISTING_NEEDS_CHANGES", link: "/listings", body: "This account is suspended."
			}));
			const suspendedAt = userModel.updateOne.mock.calls[0][1].$set.suspendedAt.getTime();
			expect(notifications.notifyMany.mock.calls[0][0][0].dedupeKey).toMatch(new RegExp(`:${suspendedAt}$`));
		});

		it("does not tell a suspended account its listings went offline when it has none", async () => {
			const { service, listingModel, notifications } = setup();
			listingModel.updateMany.mockReturnValue(exec({ matchedCount: 0 }));
			await service.suspend(reported, "first");
			expect(notifications.notify).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "LISTING_NEEDS_CHANGES" }));
		});

		it("counts a team member's report as their owner's, and the owner and member as one reporter", async () => {
			// The caller (reporter) is on owner's team; chats and tenancies hold the owner's id, never the member's.
			const owner = new Types.ObjectId();
			const team = [{ _id: owner, team: [{ user: reporter._id }] }];

			const a = setup({ verifiedReporters: 3 });
			a.userModel.find.mockReturnValue({ lean: () => exec(team) });
			a.conversationModel.distinct.mockReturnValue(exec([new Types.ObjectId(reported), owner, ...a.verified.slice(1)]));
			await a.service.create(report("Rude messages"), reporter as never);
			expect(a.userModel.updateOne).toHaveBeenCalledWith(expect.objectContaining({ suspendedAt: null }), expect.anything());

			const b = setup({ verifiedReporters: 3 });
			const other = b.verified[1];
			b.userModel.distinct.mockReturnValue(exec([reporter._id, owner, other]));
			b.userModel.find.mockReturnValue({ lean: () => exec(team) });
			b.conversationModel.distinct.mockReturnValue(exec([new Types.ObjectId(reported), owner, other]));
			await b.service.create(report("Rude messages"), reporter as never);
			expect(b.userModel.updateOne).not.toHaveBeenCalled();
		});

		it("does not suspend on 3 verified reporters when only 2 dealt with the account", async () => {
			const { service, userModel, conversationModel } = setup({ verifiedReporters: 3 });
			conversationModel.distinct.mockReturnValue(exec([new Types.ObjectId(reported), reporter._id]));
			await service.create(report("Rude messages"), reporter as never);
			expect(userModel.updateOne).not.toHaveBeenCalled();
		});

		it("a report naming no threat or scam stores no triage and hides nothing", async () => {
			const { service, flagModel, listingModel } = setup();
			await service.create(report("Rude messages, he never replies on time"), reporter as never);
			expect(flagModel.updateOne).not.toHaveBeenCalled();
			expect(listingModel.updateMany).not.toHaveBeenCalled();
		});

		it("lifts a suspension, and 404s for an account that is not suspended", async () => {
			const { service, userModel } = setup();
			await service.liftSuspension(reported);
			expect(userModel.updateOne).toHaveBeenCalledWith({ _id: reported, suspendedAt: { $ne: null } }, { $set: { suspendedAt: null, suspensionReason: null } });
			userModel.updateOne.mockReturnValue(exec({ matchedCount: 0 }));
			await expect(service.liftSuspension(reported)).rejects.toThrow("No suspended account");
		});

		it("closes reports filed during the suspension when it is lifted, so they cannot re-suspend", async () => {
			const { service, flagModel } = setup();
			await service.liftSuspension(reported);
			expect(flagModel.updateMany).toHaveBeenCalledWith(
				{ reportedUser: new Types.ObjectId(reported), status: FlagStatus.UNDER_REVIEW },
				{ $set: expect.objectContaining({ status: FlagStatus.NO_ACTION, supportResponse: expect.stringContaining("30 days") }) }
			);
		});

		it("resolves the ACCOUNT_SUSPENDED flags when the suspension is lifted, so the dashboard stops offering the button", async () => {
			const { service, flagModel } = setup();
			await service.liftSuspension(reported);
			expect(flagModel.updateMany).toHaveBeenCalledWith(
				{ reportedUser: new Types.ObjectId(reported), status: FlagStatus.ACCOUNT_SUSPENDED },
				{ $set: expect.objectContaining({ status: FlagStatus.NO_ACTION }) }
			);
		});

		it("PATCH resolve rejects a status outside the resolutions and stamps resolutionDate", async () => {
			for (const status of ["FOO", FlagStatus.UNDER_REVIEW]) {
				const errors = await validate(plainToInstance(ResolveFlagDto, { status }));
				expect(errors.map((e) => e.property)).toContain("status");
			}
			expect(await validate(plainToInstance(ResolveFlagDto, { status: FlagStatus.NO_ACTION }))).toHaveLength(0);
			const { service, flagModel } = setup();
			await service.resolve(new Types.ObjectId().toString(), { status: FlagStatus.NO_ACTION } as never);
			expect(flagModel.findByIdAndUpdate.mock.calls[0][1].$set.resolutionDate).toBeInstanceOf(Date);
		});

		it("PATCH resolve with ACCOUNT_SUSPENDED notifies the reporter of that very flag and gives it a reply", async () => {
			const { service, flagModel } = setup();
			const flagId = new Types.ObjectId();
			flagModel.findByIdAndUpdate.mockReturnValue(exec({ _id: flagId, reportedUser: new Types.ObjectId(reported) }));
			await service.resolve(flagId.toString(), { status: FlagStatus.ACCOUNT_SUSPENDED } as never);
			expect(flagModel.distinct).toHaveBeenCalledWith("createdBy", expect.objectContaining({ $or: expect.arrayContaining([{ _id: flagId }]) }));
			expect(flagModel.findByIdAndUpdate.mock.calls[0][1].$set.supportResponse).toEqual(expect.stringContaining("suspended"));
		});

		it("PATCH resolve with ACCOUNT_SUSPENDED really suspends the reported account", async () => {
			const { service, userModel } = setup();
			await service.resolve(new Types.ObjectId().toString(), { status: FlagStatus.ACCOUNT_SUSPENDED } as never);
			expect(userModel.updateOne).toHaveBeenCalledWith(
				expect.objectContaining({ _id: new Types.ObjectId(reported) }),
				{ $set: expect.objectContaining({ suspensionReason: "Suspended by Seek support" }) }
			);
		});
	});
});
