import { ForbiddenException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Types } from "mongoose";
import { UploadService } from "./upload.service";
import { Role } from "../auth/role.enum";

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
		const shareModel = { exists: jest.fn() };
		const tenancyModel = { exists: jest.fn().mockResolvedValue(null) };
		const contractModel = {
			find: jest.fn().mockReturnValue({
				select: () => ({ lean: () => ({ exec: () => Promise.resolve([]) }) })
			})
		};
		const accessModel = { create: jest.fn().mockResolvedValue({}) };
		const configService = {
			getOrThrow: (key: string) => configValues[key],
			get: (key: string) => configValues[key]
		} as ConfigService;
		const service = new UploadService(
			configService,
			listingModel as any,
			userModel as any,
			shareModel as any,
			tenancyModel as any,
			contractModel as any,
			accessModel as any
		);
		jest.spyOn(service, "getPresignedDownloadUrl")
			.mockResolvedValue("https://signed.example/file");

		return { service, listingModel, userModel, shareModel, tenancyModel, contractModel, accessModel };
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

	it("allows a landlord to download a document while the applicant's share is active", async () => {
		const { service, listingModel, userModel, shareModel } = setup();
		const documentOwnerId = new Types.ObjectId();
		listingModel.exists.mockResolvedValue(null);
		userModel.distinct.mockResolvedValue([documentOwnerId]);
		shareModel.exists.mockResolvedValue({ _id: new Types.ObjectId() });

		await expect(service.getAuthorizedPrivateDownloadUrl(
			"private/passport.pdf",
			{ _id: new Types.ObjectId(), role: Role.LANDLORD_AGENCY } as any
		)).resolves.toBe("https://signed.example/file");
		expect(shareModel.exists).toHaveBeenCalledWith(
			expect.objectContaining({
				owner: { $in: [documentOwnerId] },
				revokedAt: null,
				expiresAt: { $gt: expect.any(Date) }
			})
		);
	});

	it("logs each shared download for the student's access history", async () => {
		const { service, listingModel, userModel, shareModel, accessModel } = setup();
		const documentOwnerId = new Types.ObjectId();
		const viewerId = new Types.ObjectId();
		const shareId = new Types.ObjectId();
		listingModel.exists.mockResolvedValue(null);
		userModel.distinct.mockResolvedValue([documentOwnerId]);
		shareModel.exists.mockResolvedValue({ _id: shareId });

		await service.getAuthorizedPrivateDownloadUrl("private/passport.pdf", { _id: viewerId, role: Role.LANDLORD_AGENCY } as any);

		expect(accessModel.create).toHaveBeenCalledWith(
			expect.objectContaining({ owner: documentOwnerId, viewer: viewerId, key: "private/passport.pdf", share: shareId })
		);
	});

	it("lets a tenancy member open the tenancy's documents", async () => {
		const { service, listingModel, userModel, tenancyModel } = setup();
		listingModel.exists.mockResolvedValue(null);
		tenancyModel.exists.mockResolvedValueOnce({ _id: new Types.ObjectId() });

		await expect(service.getAuthorizedPrivateDownloadUrl(
			"private/seed/cotham-agreement-2026.pdf",
			{ _id: new Types.ObjectId() } as any
		)).resolves.toBe("https://signed.example/file");
		expect(userModel.distinct).not.toHaveBeenCalled();
	});

	it("rejects someone outside the tenancy", async () => {
		const { service, listingModel, userModel, shareModel } = setup();
		listingModel.exists.mockResolvedValue(null);
		userModel.distinct.mockResolvedValue([]);
		shareModel.exists.mockResolvedValue(null);

		await expect(service.getAuthorizedPrivateDownloadUrl(
			"private/seed/cotham-agreement-2026.pdf",
			{ _id: new Types.ObjectId() } as any
		)).rejects.toBeInstanceOf(ForbiddenException);
	});

	it("rejects an unrelated private key", async () => {
		const { service, listingModel, userModel, shareModel } = setup();
		listingModel.exists.mockResolvedValue(null);
		userModel.distinct.mockResolvedValue([new Types.ObjectId()]);
		shareModel.exists.mockResolvedValue(null);

		await expect(service.getAuthorizedPrivateDownloadUrl(
			"private/unrelated.pdf",
			{ _id: new Types.ObjectId() } as any
		)).rejects.toBeInstanceOf(ForbiddenException);
	});

	it("lets a student download their own document without a share", async () => {
		const { service, listingModel, userModel, shareModel } = setup();
		const ownerId = new Types.ObjectId();
		listingModel.exists.mockResolvedValue(null);
		userModel.distinct.mockResolvedValue([ownerId]);

		await expect(service.getAuthorizedPrivateDownloadUrl(
			`private/${ownerId.toHexString()}/123e4567-e89b-12d3-a456-426614174000.pdf`,
			{ _id: ownerId } as any
		)).resolves.toBe("https://signed.example/file");
		expect(shareModel.exists).not.toHaveBeenCalled();
	});

	it("rejects a landlord once the share has expired or been revoked", async () => {
		const { service, listingModel, userModel, shareModel } = setup();
		listingModel.exists.mockResolvedValue(null);
		userModel.distinct.mockResolvedValue([new Types.ObjectId()]);
		shareModel.exists.mockResolvedValue(null);

		await expect(service.getAuthorizedPrivateDownloadUrl(
			"private/passport.pdf",
			{ _id: new Types.ObjectId(), role: Role.LANDLORD_AGENCY } as any
		)).rejects.toBeInstanceOf(ForbiddenException);
		expect(shareModel.exists).toHaveBeenCalledWith(
			expect.objectContaining({ revokedAt: null, expiresAt: { $gt: expect.any(Date) } })
		);
	});

	it("lets a student open a key minted for them before it is filed on the profile", async () => {
		const { service, listingModel, userModel, shareModel } = setup();
		const ownerId = new Types.ObjectId();
		listingModel.exists.mockResolvedValue(null);
		userModel.distinct.mockResolvedValue([]);

		await expect(service.getAuthorizedPrivateDownloadUrl(
			`private/${ownerId.toHexString()}/123e4567-e89b-12d3-a456-426614174000.pdf`,
			{ _id: ownerId, role: Role.STUDENT } as any
		)).resolves.toBe("https://signed.example/file");
		expect(shareModel.exists).not.toHaveBeenCalled();
	});

	it("lets a student tenant and the landlord open a contract of their tenancy", async () => {
		const { service, listingModel, tenancyModel, contractModel, userModel } = setup();
		const tenancyId = new Types.ObjectId();
		listingModel.exists.mockResolvedValue(null);
		contractModel.find.mockReturnValue({
			select: () => ({ lean: () => ({ exec: () => Promise.resolve([{ tenancy: tenancyId }]) }) })
		});

		for (const role of [Role.STUDENT, Role.LANDLORD_AGENCY]) {
			tenancyModel.exists.mockResolvedValueOnce(null).mockResolvedValueOnce({ _id: tenancyId });
			await expect(service.getAuthorizedPrivateDownloadUrl(
				"private/contracts/agreement.pdf",
				{ _id: new Types.ObjectId(), role } as any
			)).resolves.toBe("https://signed.example/file");
		}
		expect(tenancyModel.exists).toHaveBeenCalledWith(
			expect.objectContaining({ _id: { $in: [tenancyId] } })
		);
		expect(userModel.distinct).not.toHaveBeenCalled();
	});

	it("never lets another student use a share, even a live one", async () => {
		const { service, listingModel, userModel, shareModel } = setup();
		listingModel.exists.mockResolvedValue(null);
		userModel.distinct.mockResolvedValue([new Types.ObjectId()]);
		shareModel.exists.mockResolvedValue({ _id: new Types.ObjectId() });

		await expect(service.getAuthorizedPrivateDownloadUrl(
			"private/passport.pdf",
			{ _id: new Types.ObjectId(), role: Role.STUDENT } as any
		)).rejects.toBeInstanceOf(ForbiddenException);
		expect(shareModel.exists).not.toHaveBeenCalled();
	});

	it("rejects keys outside the private namespace", async () => {
		const { service } = setup();
		await expect(service.getAuthorizedPrivateDownloadUrl(
			"public/photo.jpg",
			{ _id: new Types.ObjectId() } as any
		)).rejects.toBeInstanceOf(ForbiddenException);
	});

	it("resolves an owner-scoped key only to the user it was issued to", async () => {
		const { service, listingModel, userModel, shareModel } = setup();
		const realOwner = new Types.ObjectId();
		const claimant = new Types.ObjectId();
		listingModel.exists.mockResolvedValue(null);
		// Both users hold the key — the claimant recorded it against their own
		// profile. Only the owner named in the key may resolve it.
		userModel.distinct.mockResolvedValue([realOwner, claimant]);
		shareModel.exists.mockResolvedValue({ _id: new Types.ObjectId() });

		await service.getAuthorizedPrivateDownloadUrl(
			`private/${realOwner.toHexString()}/123e4567-e89b-12d3-a456-426614174000.pdf`,
			{ _id: new Types.ObjectId(), role: Role.LANDLORD_AGENCY } as any
		);

		expect(shareModel.exists).toHaveBeenCalledWith(
			expect.objectContaining({ owner: { $in: [realOwner] } })
		);
	});

	describe("presigned uploads", () => {
		const ownerId = "507f1f77bcf86cd799439011";

		it("derives the key from the owner, never the client filename", async () => {
			const { service } = setup();

			const { key } = await service.getPresignedUploadUrl(
				"application/pdf",
				"private",
				ownerId,
				1024
			);

			expect(key).toMatch(
				new RegExp(`^private/${ownerId}/[0-9a-f-]{36}\\.pdf$`)
			);
		});

		it("rejects a file above the size ceiling", async () => {
			const { service } = setup();

			await expect(service.getPresignedUploadUrl(
				"image/png",
				"public",
				ownerId,
				50 * 1024 * 1024
			)).rejects.toThrow(/15MB or smaller/);
		});
	});
});
