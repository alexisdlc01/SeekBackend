import { Test, TestingModule } from "@nestjs/testing";
import { getModelToken } from "@nestjs/mongoose";
import { Types } from "mongoose";
import { ApplicationService } from "./application.service";
import { Application } from "./application.schema";
import { ApplicationStage } from "./enums/application-stage.enum";
import { Conversation } from "src/conversation/converstaion.schema";
import { ListingsService } from "../listings/listings.service";
import { UsersRepository } from "src/users/users.repository";

describe("ApplicationService", () => {
	let service: ApplicationService;

	beforeEach(async () => {
		const module: TestingModule = await Test.createTestingModule({
			providers: [
				ApplicationService,
				{ provide: getModelToken(Application.name), useValue: {} },
				{ provide: getModelToken(Conversation.name), useValue: {} },
				{ provide: ListingsService, useValue: {} },
				{ provide: UsersRepository, useValue: {} }
			]
		}).compile();

		service = module.get<ApplicationService>(ApplicationService);
	});

	it("should be defined", () => {
		expect(service).toBeDefined();
	});
});

const doc = (plain: any) => ({ ...plain, toObject: () => plain });

describe("ApplicationService.getAllByListing", () => {
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

	const service = new ApplicationService(
		applicationModel as any,
		{} as any,
		{} as any,
		{} as any
	);

	it("only returns applications the student has actually sent", async () => {
		await service.getAllByListing(listing.toHexString());

		const [filter] = applicationModel.find.mock.calls[0];
		expect(filter.listing).toBe(listing.toHexString());
		expect(filter.$or.map((c: any) => c.stage).sort()).toEqual(
			["ACCEPTED", "REJECTED", "SENT"]
		);
	});

	it("exposes populated applicants safely and keeps applicant ids intact", async () => {
		const [application] = await service.getAllByListing(listing.toHexString());

		expect(query.populate).toHaveBeenCalledWith({
			path: "applicants",
			select: "name email profilePicUrl"
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
