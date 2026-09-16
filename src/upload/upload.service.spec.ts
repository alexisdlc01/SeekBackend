import { ForbiddenException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Types } from "mongoose";
import { ApplicationStage } from "../application/enums/application-stage.enum";
import { UploadService } from "./upload.service";

describe("UploadService private-file authorization", () => {
	const configValues: Record<string, string> = {
		AWS_S3_REGION: "eu-west-1",
		AWS_ACCESS_KEY_ID: "test-access",
		AWS_SECRET_ACCESS_KEY: "test-secret",
		AWS_PUBLIC_BUCKET: "public-test",
		AWS_PRIVATE_BUCKET: "private-test"
	};

	function setup() {
		const listingModel = { exists: jest.fn() };
		const userModel = { distinct: jest.fn() };
		const applicationModel = { exists: jest.fn() };
		const configService = {
			getOrThrow: (key: string) => configValues[key],
			get: (key: string) => configValues[key]
		} as ConfigService;
		const service = new UploadService(
			configService,
			listingModel as any,
			userModel as any,
			applicationModel as any
		);
		jest.spyOn(service, "getPresignedDownloadUrl")
			.mockResolvedValue("https://signed.example/file");

		return { service, listingModel, userModel, applicationModel };
	}

	it("allows a landlord to download a title document for their listing", async () => {
		const { service, listingModel, userModel } = setup();
		listingModel.exists.mockResolvedValue({ _id: new Types.ObjectId() });

		await expect(service.getAuthorizedPrivateDownloadUrl(
			"private/title.pdf",
			{ _id: new Types.ObjectId() } as any
		)).resolves.toBe("https://signed.example/file");
		expect(userModel.distinct).not.toHaveBeenCalled();
	});

	it("allows a landlord to download a document from an applicant they may review", async () => {
		const { service, listingModel, userModel, applicationModel } = setup();
		const documentOwnerId = new Types.ObjectId();
		listingModel.exists.mockResolvedValue(null);
		userModel.distinct.mockResolvedValue([documentOwnerId]);
		applicationModel.exists.mockResolvedValue({ _id: new Types.ObjectId() });

		await expect(service.getAuthorizedPrivateDownloadUrl(
			"private/passport.pdf",
			{ _id: new Types.ObjectId() } as any
		)).resolves.toBe("https://signed.example/file");
		expect(applicationModel.exists).toHaveBeenCalledWith(
			expect.objectContaining({
				applicants: { $in: [documentOwnerId] },
				stage: {
					$in: [
						ApplicationStage.SENT,
						ApplicationStage.ACCEPTED,
						ApplicationStage.REJECTED
					]
				}
			})
		);
	});

	it("rejects an unrelated private key", async () => {
		const { service, listingModel, userModel, applicationModel } = setup();
		listingModel.exists.mockResolvedValue(null);
		userModel.distinct.mockResolvedValue([new Types.ObjectId()]);
		applicationModel.exists.mockResolvedValue(null);

		await expect(service.getAuthorizedPrivateDownloadUrl(
			"private/unrelated.pdf",
			{ _id: new Types.ObjectId() } as any
		)).rejects.toBeInstanceOf(ForbiddenException);
	});

	it("rejects keys outside the private namespace", async () => {
		const { service } = setup();
		await expect(service.getAuthorizedPrivateDownloadUrl(
			"public/photo.jpg",
			{ _id: new Types.ObjectId() } as any
		)).rejects.toBeInstanceOf(ForbiddenException);
	});
});
