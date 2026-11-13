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

	it("stores the flag without any admin email (no human queue)", async () => {
		const stored = { _id: "flag-2", text: "spam" };
		const flagModel = { create: jest.fn().mockResolvedValue({ ...stored, toObject: () => stored }) };
		const userModel = { exists: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({ _id: "u" }) }) };
		const service = new FlagsService(flagModel as never, userModel as never);
		jest.spyOn((service as any).logger, "error").mockImplementation(() => undefined);

		await expect(
			service.create({ reportedUser: "64b64b64b64b64b64b64b64b", text: "spam" } as never, { _id: "u", email: "a@st-andrews.ac.uk" } as never)
		).resolves.toBe(stored);
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

		const setup = (opts: { answer?: string | null; verifiedReporters?: number; linked?: boolean; configured?: boolean; severeFromReporter?: number; reportedSpoke?: boolean } = {}) => {
			// Verified reporters; the first one is the caller of create().
			const verified = [reporter._id, ...Array.from({ length: Math.max(0, (opts.verifiedReporters ?? 1) - 1) }, () => new Types.ObjectId())];
			const stored = { _id: new Types.ObjectId(), toObject: () => ({}) };
			const flagModel = {
				create: jest.fn().mockResolvedValue(stored),
				updateOne: jest.fn().mockReturnValue(exec({})),
				updateMany: jest.fn().mockReturnValue(exec({})),
				distinct: jest.fn().mockReturnValue(exec([new Types.ObjectId()])),
				countDocuments: jest.fn().mockReturnValue(exec(opts.severeFromReporter ?? 1)),
				findByIdAndUpdate: jest.fn().mockReturnValue(exec({ reportedUser: new Types.ObjectId(reported) }))
			};
			const userModel = {
				exists: jest.fn().mockReturnValue(exec({ _id: reported })),
				distinct: jest.fn().mockReturnValue(exec(opts.verifiedReporters === 0 ? [] : verified)),
				updateOne: jest.fn().mockReturnValue(exec({ modifiedCount: 1 }))
			};
			const listingModel = { updateMany: jest.fn().mockReturnValue(exec({})) };
			const llm = {
				isConfigured: () => opts.configured ?? true,
				complete: jest.fn().mockResolvedValue(opts.answer === null ? null : { text: opts.answer ?? "{}", provider: "gemini" })
			};
			const notifications = { notifyMany: jest.fn().mockResolvedValue(undefined) };
			// Every verified reporter shares a conversation with the reported account unless linked is false.
			const conversationModel = { distinct: jest.fn().mockReturnValue(exec(opts.linked === false ? [] : [new Types.ObjectId(reported), ...verified])) };
			const tenancyModel = { find: jest.fn().mockReturnValue({ lean: () => exec([]) }) };
			// Conversations the reported account wrote in; none when reportedSpoke is false.
			const messageModel = { distinct: jest.fn().mockReturnValue(exec(opts.reportedSpoke === false ? [] : [new Types.ObjectId()])) };
			const service = new FlagsService(
				flagModel as never,
				userModel as never,
				llm as never,
				listingModel as never,
				undefined,
				notifications as never,
				conversationModel as never,
				tenancyModel as never,
				messageModel as never
			);
			jest.spyOn((service as any).logger, "warn").mockImplementation(() => undefined);
			return { service, flagModel, userModel, listingModel, llm, notifications, conversationModel, messageModel };
		};
		const report = (text = "He asked me to wire the deposit before any viewing") =>
			({ reportedUser: reported, text, category: "SCAM" }) as never;

		it("stores the AI triage and, on one severe report from a linked verified reporter, hides the listings without suspending", async () => {
			const { service, flagModel, userModel, listingModel } = setup({
				answer: '{"category":"FRAUD_SCAM","severity":"high","summary":"Landlord asked for a deposit by wire transfer."}'
			});
			await service.create(report(), reporter as never);

			expect(flagModel.updateOne).toHaveBeenCalledWith(
				expect.anything(),
				{ $set: { triage: { category: "FRAUD_SCAM", severity: "high", summary: "Landlord asked for a deposit by wire transfer.", provider: "gemini" } } }
			);
			expect(userModel.updateOne).not.toHaveBeenCalled();
			expect(listingModel.updateMany).toHaveBeenCalledWith(
				expect.objectContaining({ isDraft: false }),
				{ $set: expect.objectContaining({ isVerified: false, moderationStatus: "NEEDS_CHANGES", lastUpdated: expect.any(Date) }) }
			);
			// Neutral reason: a landlord with one applicant must not learn who reported him.
			expect(listingModel.updateMany.mock.calls[0][1].$set.moderationReasons[0]).not.toMatch(/student|report/i);
		});

		it("hides the listings only once per reporter in 30 days, however often the same account reports", async () => {
			const { service, listingModel } = setup({ answer: '{"category":"FRAUD_SCAM","severity":"high","summary":"Scam."}', severeFromReporter: 2 });
			await service.create(report(), reporter as never);
			expect(listingModel.updateMany).not.toHaveBeenCalled();
		});

		it("does not count a conversation the reported account never wrote in (applying alone creates one)", async () => {
			const { service, userModel, conversationModel } = setup({ answer: null, verifiedReporters: 3, reportedSpoke: false });
			await service.create(report("Rude messages"), reporter as never);
			expect(conversationModel.distinct).not.toHaveBeenCalled();
			expect(userModel.updateOne).not.toHaveBeenCalled();
		});

		it("counts open reports only, so a lifted suspension is not undone by the next report", async () => {
			const { service, flagModel } = setup({ answer: null });
			await service.create(report("Rude messages"), reporter as never);
			expect(flagModel.distinct).toHaveBeenCalledWith("createdBy", expect.objectContaining({ status: FlagStatus.UNDER_REVIEW }));
		});

		it("ignores a severe report from someone who never dealt with the account", async () => {
			const { service, userModel, listingModel } = setup({ answer: '{"category":"FRAUD_SCAM","severity":"high","summary":"Scam."}', verifiedReporters: 3, linked: false });
			await service.create(report(), reporter as never);
			expect(userModel.updateOne).not.toHaveBeenCalled();
			expect(listingModel.updateMany).not.toHaveBeenCalled();
		});

		it("does nothing on a severe report from an unverified reporter", async () => {
			const { service, userModel, listingModel } = setup({ answer: '{"category":"THREATS_VIOLENCE","severity":"high","summary":"Threat."}', verifiedReporters: 0 });
			await service.create(report(), { ...reporter, isVerified: false } as never);
			expect(userModel.updateOne).not.toHaveBeenCalled();
			expect(listingModel.updateMany).not.toHaveBeenCalled();
		});

		it("suspends after reports from 3 distinct linked verified reporters in 30 days, even with the AI down", async () => {
			const { service, flagModel, userModel, listingModel, notifications } = setup({ answer: null, verifiedReporters: 3 });
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

		it("does not suspend on 3 verified reporters when only 2 dealt with the account", async () => {
			const { service, userModel, conversationModel } = setup({ answer: null, verifiedReporters: 3 });
			conversationModel.distinct.mockReturnValue(exec([new Types.ObjectId(reported), reporter._id]));
			await service.create(report("Rude messages"), reporter as never);
			expect(userModel.updateOne).not.toHaveBeenCalled();
		});

		it("drops an off-list category and blanks a summary carrying contact details (injection-safe)", async () => {
			const bad = setup({ answer: '{"category":"IGNORE_RULES","severity":"high","summary":"x"}' });
			await bad.service.create(report(), reporter as never);
			expect(bad.flagModel.updateOne).not.toHaveBeenCalled();

			const leaky = setup({ answer: '{"category":"SPAM","severity":"low","summary":"Call 07700 900123 or pay to sort code 12-34-56"}' });
			await leaky.service.create(report(), reporter as never);
			expect(leaky.flagModel.updateOne.mock.calls[0][1].$set.triage.summary).toBe("");
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
