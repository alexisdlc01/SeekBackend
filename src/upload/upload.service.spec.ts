import { ForbiddenException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Types } from "mongoose";
import { UploadService } from "./upload.service";
import { ContractStatus } from "../contracts/contract.schema";
import { Role } from "../auth/role.enum";
import { TeamScope } from "../users/types/team-scope";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

jest.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: jest.fn().mockResolvedValue("https://signed.example/upload") }));

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
		const userModel = { distinct: jest.fn(), exists: jest.fn().mockResolvedValue(null) };
		const shareModel = { exists: jest.fn() };
		const tenancyModel = { exists: jest.fn().mockResolvedValue(null) };
		const contractModel = {
			find: jest.fn().mockReturnValue({
				select: () => ({ lean: () => ({ exec: () => Promise.resolve([]) }) })
			})
		};
		const accessModel = { create: jest.fn().mockResolvedValue({}) };
		const emailModel = { exists: jest.fn().mockResolvedValue(null) };
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
			accessModel as any,
			emailModel as any
		);
		jest.spyOn(service, "getPresignedDownloadUrl")
			.mockResolvedValue("https://signed.example/file");

		return { service, listingModel, userModel, shareModel, tenancyModel, contractModel, accessModel, emailModel };
	}

	it("deletes only private files, from the private bucket", async () => {
		const { service } = setup();
		const send = jest.spyOn((service as any).s3Client, "send").mockResolvedValue({} as never);
		await expect(service.deletePrivateObject("public/abc/listing.jpg")).rejects.toThrow();
		expect(send).not.toHaveBeenCalled();
		await service.deletePrivateObject("private/abc/passport.pdf");
		expect((send.mock.calls[0][0] as any).input).toEqual({ Bucket: "private-test", Key: "private/abc/passport.pdf" });
	});

	it("encrypts server-side private uploads with S3 AES256", async () => {
		const { service } = setup();
		const send = jest.spyOn((service as any).s3Client, "send").mockResolvedValue({} as never);
		await service.putPrivateObject(new Types.ObjectId().toString(), Buffer.from("photo"), "image/jpeg", "jpg");
		expect((send.mock.calls[0][0] as any).input.ServerSideEncryption).toBe("AES256");
	});

	it("does not sign an encryption header into public or private presigned uploads", async () => {
		const { service } = setup();
		const presign = getSignedUrl as jest.MockedFunction<typeof getSignedUrl>;
		presign.mockClear();
		await service.getPresignedUploadUrl("image/jpeg", "public", new Types.ObjectId().toString(), 5);
		await service.getPresignedUploadUrl("image/jpeg", "private", new Types.ObjectId().toString(), 5);
		for (const [, command] of presign.mock.calls) {
			expect((command as any).input).not.toHaveProperty("ServerSideEncryption");
		}
	});

	it("lets a superuser open a listing's title deed but no other private file", async () => {
		const { service, listingModel } = setup();
		const staff = { _id: new Types.ObjectId(), role: Role.SUPERUSER } as any;
		const key = `private/${new Types.ObjectId().toHexString()}/123e4567-e89b-12d3-a456-426614174000.pdf`;
		listingModel.exists.mockResolvedValueOnce({ _id: new Types.ObjectId() });
		await expect(service.getAuthorizedPrivateDownloadUrl(key, staff)).resolves.toBe("https://signed.example/file");
		expect(listingModel.exists).toHaveBeenCalledWith({ registerOfTitleKey: key });

		listingModel.exists.mockResolvedValueOnce(null);
		await expect(service.getAuthorizedPrivateDownloadUrl(key, staff)).rejects.toBeInstanceOf(ForbiddenException);
	});

	it("allows a landlord to download a title document for their listing", async () => {
		const { service, listingModel, userModel } = setup();
		listingModel.exists.mockResolvedValue({ _id: new Types.ObjectId() });
		const landlordId = new Types.ObjectId();

		await expect(service.getAuthorizedPrivateDownloadUrl(
			`private/${landlordId.toHexString()}/123e4567-e89b-12d3-a456-426614174000.pdf`,
			{ _id: landlordId } as any
		)).resolves.toBe("https://signed.example/file");
		expect(userModel.distinct).not.toHaveBeenCalled();
	});

	it("still opens a title document uploaded before keys named their owner", async () => {
		const { service, listingModel, userModel } = setup();
		const landlordId = new Types.ObjectId();
		listingModel.exists.mockResolvedValue({ _id: new Types.ObjectId() });
		userModel.distinct.mockResolvedValue([]);
		const legacy = "private/1696150000000-title.pdf";

		await expect(service.getAuthorizedPrivateDownloadUrl(legacy, { _id: landlordId } as any)).resolves.toBe("https://signed.example/file");
		expect(listingModel.exists).toHaveBeenCalledWith({ landlord: landlordId.toString(), registerOfTitleKey: legacy });

		// The same old-format key filed as a student's document must still go through the share checks.
		userModel.exists.mockResolvedValue({ _id: new Types.ObjectId() });
		await expect(service.getAuthorizedPrivateDownloadUrl(legacy, { _id: landlordId, role: Role.LANDLORD_AGENCY } as any)).rejects.toBeInstanceOf(ForbiddenException);
	});

	it("does not let a student's key stored on the landlord's listing skip the share checks", async () => {
		const { service, listingModel, userModel, shareModel } = setup();
		const studentId = new Types.ObjectId();
		listingModel.exists.mockResolvedValue({ _id: new Types.ObjectId() });
		userModel.distinct.mockResolvedValue([studentId]);
		shareModel.exists.mockResolvedValue(null);

		await expect(service.getAuthorizedPrivateDownloadUrl(
			`private/${studentId.toHexString()}/123e4567-e89b-12d3-a456-426614174000.pdf`,
			{ _id: new Types.ObjectId(), role: Role.LANDLORD_AGENCY } as any
		)).rejects.toBeInstanceOf(ForbiddenException);
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
		expect(tenancyModel.exists).toHaveBeenCalledWith({ $or: [
			expect.objectContaining({ _id: { $in: [tenancyId] } }),
			expect.objectContaining({ _id: { $in: [tenancyId] } }),
		] });
		expect(userModel.distinct).not.toHaveBeenCalled();
	});

	it("never lets a tenant open a draft contract, but the landlord still can", async () => {
		const { service, listingModel, tenancyModel, contractModel } = setup();
		const tenancyId = new Types.ObjectId();
		listingModel.exists.mockResolvedValue(null);
		contractModel.find.mockReturnValue({
			select: () => ({ lean: () => ({ exec: () => Promise.resolve([{ tenancy: tenancyId, status: ContractStatus.DRAFT }]) }) })
		});
		const studentId = new Types.ObjectId();
		await service.getAuthorizedPrivateDownloadUrl(
			`private/${new Types.ObjectId().toHexString()}/123e4567-e89b-12d3-a456-426614174000.pdf`,
			{ _id: studentId, role: Role.STUDENT } as any
		).catch(() => null);
		expect(tenancyModel.exists).toHaveBeenCalledWith({ $or: [
			{ landlord: studentId, _id: { $in: [tenancyId] } },
			{ tenants: studentId, _id: { $in: [] } },
		] });
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

	describe("team members acting as the landlord", () => {
		const landlordId = new Types.ObjectId();
		const landlord = { _id: landlordId, role: Role.LANDLORD_AGENCY } as any;
		const ownKey = `private/${landlordId.toHexString()}/123e4567-e89b-12d3-a456-426614174000.pdf`;

		it("lets a LISTINGS member open the listing's register of title", async () => {
			const { service, listingModel } = setup();
			listingModel.exists.mockResolvedValue({ _id: new Types.ObjectId() });
			await expect(service.getAuthorizedPrivateDownloadUrl(ownKey, landlord, [TeamScope.LISTINGS]))
				.resolves.toBe("https://signed.example/file");
		});

		it("denies a LISTINGS member an applicant's shared document", async () => {
			const { service, listingModel, userModel, shareModel } = setup();
			const studentId = new Types.ObjectId();
			listingModel.exists.mockResolvedValue(null);
			userModel.distinct.mockResolvedValue([studentId]);
			shareModel.exists.mockResolvedValue({ _id: new Types.ObjectId() });
			await expect(service.getAuthorizedPrivateDownloadUrl(
				`private/${studentId.toHexString()}/123e4567-e89b-12d3-a456-426614174000.pdf`,
				landlord,
				[TeamScope.LISTINGS]
			)).rejects.toBeInstanceOf(ForbiddenException);
			expect(shareModel.exists).not.toHaveBeenCalled();
		});

		it("denies a LISTINGS member a tenancy document, which a TENANCIES member opens", async () => {
			const { service, listingModel, userModel, tenancyModel } = setup();
			listingModel.exists.mockResolvedValue(null);
			userModel.distinct.mockResolvedValue([]);
			tenancyModel.exists.mockResolvedValue({ _id: new Types.ObjectId() });
			await expect(service.getAuthorizedPrivateDownloadUrl("private/seed/cotham-agreement-2026.pdf", landlord, [TeamScope.LISTINGS]))
				.rejects.toBeInstanceOf(ForbiddenException);
			expect(tenancyModel.exists).not.toHaveBeenCalled();

			await expect(service.getAuthorizedPrivateDownloadUrl("private/seed/cotham-agreement-2026.pdf", landlord, [TeamScope.TENANCIES]))
				.resolves.toBe("https://signed.example/file");
		});

		it("denies a TENANCIES member the register of title", async () => {
			const { service, listingModel, userModel } = setup();
			listingModel.exists.mockResolvedValue({ _id: new Types.ObjectId() });
			userModel.distinct.mockResolvedValue([]);
			await expect(service.getAuthorizedPrivateDownloadUrl(ownKey, landlord, [TeamScope.TENANCIES]))
				.rejects.toBeInstanceOf(ForbiddenException);
		});

		it("lets an APPLICATIONS member open a live share, but not the owner's own unfiled key", async () => {
			const { service, listingModel, userModel, shareModel } = setup();
			listingModel.exists.mockResolvedValue(null);
			userModel.distinct.mockResolvedValue([new Types.ObjectId()]);
			shareModel.exists.mockResolvedValue({ _id: new Types.ObjectId() });
			await expect(service.getAuthorizedPrivateDownloadUrl("private/passport.pdf", landlord, [TeamScope.APPLICATIONS]))
				.resolves.toBe("https://signed.example/file");

			userModel.distinct.mockResolvedValue([]);
			await expect(service.getAuthorizedPrivateDownloadUrl(ownKey, landlord, [TeamScope.APPLICATIONS]))
				.rejects.toBeInstanceOf(ForbiddenException);
			// The landlord themselves still opens it.
			await expect(service.getAuthorizedPrivateDownloadUrl(ownKey, landlord))
				.resolves.toBe("https://signed.example/file");
		});

		it("lets a VIEWINGS_INBOX member open an attachment synced into the owner's inbox", async () => {
			const { service, listingModel, userModel, emailModel } = setup();
			listingModel.exists.mockResolvedValue(null);
			userModel.distinct.mockResolvedValue([]);
			emailModel.exists.mockResolvedValue({ _id: new Types.ObjectId() });
			await expect(service.getAuthorizedPrivateDownloadUrl(ownKey, landlord, [TeamScope.VIEWINGS_INBOX]))
				.resolves.toBe("https://signed.example/file");
			expect(emailModel.exists).toHaveBeenCalledWith({ user: landlordId, "attachments.key": ownKey });
		});

		it("denies a VIEWINGS_INBOX member an owner key that no email carries", async () => {
			const { service, listingModel, userModel, emailModel } = setup();
			listingModel.exists.mockResolvedValue(null);
			userModel.distinct.mockResolvedValue([]);
			emailModel.exists.mockResolvedValue(null);
			await expect(service.getAuthorizedPrivateDownloadUrl(ownKey, landlord, [TeamScope.VIEWINGS_INBOX]))
				.rejects.toBeInstanceOf(ForbiddenException);
		});

		it("denies a VIEWINGS_INBOX member another owner's attachment key", async () => {
			const { service, listingModel, userModel, emailModel } = setup();
			listingModel.exists.mockResolvedValue(null);
			userModel.distinct.mockResolvedValue([]);
			emailModel.exists.mockResolvedValue({ _id: new Types.ObjectId() });
			const otherKey = `private/${new Types.ObjectId().toHexString()}/123e4567-e89b-12d3-a456-426614174000.pdf`;
			await expect(service.getAuthorizedPrivateDownloadUrl(otherKey, landlord, [TeamScope.VIEWINGS_INBOX]))
				.rejects.toBeInstanceOf(ForbiddenException);
			expect(emailModel.exists).not.toHaveBeenCalled();
		});

		it("denies a member without VIEWINGS_INBOX an inbox attachment", async () => {
			const { service, listingModel, userModel, emailModel } = setup();
			listingModel.exists.mockResolvedValue(null);
			userModel.distinct.mockResolvedValue([]);
			emailModel.exists.mockResolvedValue({ _id: new Types.ObjectId() });
			await expect(service.getAuthorizedPrivateDownloadUrl(ownKey, landlord, [TeamScope.APPLICATIONS, TeamScope.LISTINGS]))
				.rejects.toBeInstanceOf(ForbiddenException);
			expect(emailModel.exists).not.toHaveBeenCalled();
		});

		it("leaves a non-member landlord unchanged: title deed, tenancy file and live share all open", async () => {
			const { service, listingModel, userModel, shareModel, tenancyModel } = setup();
			listingModel.exists.mockResolvedValueOnce({ _id: new Types.ObjectId() });
			await expect(service.getAuthorizedPrivateDownloadUrl(ownKey, landlord)).resolves.toBe("https://signed.example/file");

			listingModel.exists.mockResolvedValue(null);
			tenancyModel.exists.mockResolvedValueOnce({ _id: new Types.ObjectId() });
			await expect(service.getAuthorizedPrivateDownloadUrl("private/seed/cotham-agreement-2026.pdf", landlord))
				.resolves.toBe("https://signed.example/file");

			userModel.distinct.mockResolvedValue([new Types.ObjectId()]);
			shareModel.exists.mockResolvedValue({ _id: new Types.ObjectId() });
			await expect(service.getAuthorizedPrivateDownloadUrl("private/passport.pdf", landlord))
				.resolves.toBe("https://signed.example/file");
		});
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
