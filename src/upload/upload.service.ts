import {
	BadRequestException,
	ForbiddenException,
	Injectable
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
	DeleteObjectCommand,
	GetObjectCommand,
	PutObjectCommand,
	S3Client
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { randomUUID } from "node:crypto";
import { Listing } from "../listings/listings.schema";
import { User } from "../users/users.schema";
import { DocumentShare } from "../users/shares/document-share.schema";
import { DocumentAccess } from "../users/shares/document-access.schema";
import { Tenancy } from "../tenancies/tenancy.schema";
import { Contract } from "../contracts/contract.schema";
import {
	ALLOWED_UPLOAD_TYPES,
	MAX_UPLOAD_BYTES
} from "./dto/presign.dto";
import { Role } from "../auth/role.enum";
import { isKeyOwnedBy, ownerIdFromKey } from "./object-key";

@Injectable()
export class UploadService {
	private readonly s3Client: S3Client;
	private readonly publicBucket: string;
	private readonly privateBucket: string;

	constructor(
		private readonly configService: ConfigService,
		@InjectModel(Listing.name)
		private readonly listingModel: Model<Listing>,
		@InjectModel(User.name)
		private readonly userModel: Model<User>,
		@InjectModel(DocumentShare.name)
		private readonly shareModel: Model<DocumentShare>,
		@InjectModel(Tenancy.name)
		private readonly tenancyModel: Model<Tenancy>,
		@InjectModel(Contract.name)
		private readonly contractModel: Model<Contract>,
		@InjectModel(DocumentAccess.name)
		private readonly accessModel: Model<DocumentAccess>
	) {
		this.s3Client = new S3Client({
			region: this.configService.getOrThrow("AWS_S3_REGION"),
			credentials: {
				accessKeyId: this.configService.getOrThrow("AWS_ACCESS_KEY_ID"),
				secretAccessKey: this.configService.getOrThrow(
					"AWS_SECRET_ACCESS_KEY"
				)
			}
		});
		this.publicBucket = this.configService.getOrThrow("AWS_PUBLIC_BUCKET");
		this.privateBucket =
			this.configService.getOrThrow("AWS_PRIVATE_BUCKET");
	}

	async getPresignedUploadUrl(
		fileType: string,
		folder: "public" | "private",
		ownerId: string,
		fileSize: number
	) {
		if (fileSize > MAX_UPLOAD_BYTES) {
			throw new BadRequestException(
				`Files must be ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB or smaller.`
			);
		}

		const bucket =
			folder === "private" ? this.privateBucket : this.publicBucket;

		// The key is derived entirely from server-side values. The client's
		// filename is never interpolated, so it cannot steer the object
		// anywhere — including into another user's namespace.
		const extension = ALLOWED_UPLOAD_TYPES[fileType];
		const key = `${folder}/${ownerId}/${randomUUID()}.${extension}`;

		const command =
			folder === "private"
				? new PutObjectCommand({
					Bucket: bucket,
					Key: key,
					ContentType: fileType,
					ContentLength: fileSize,
					ACL: "private"
				})
				: new PutObjectCommand({
					Bucket: bucket,
					Key: key,
					ContentType: fileType,
					ContentLength: fileSize
				});

		// Content type and length are signed into the URL, so S3 itself rejects
		// a PUT that swaps the type or sends a body of a different size.
		const uploadUrl = await getSignedUrl(this.s3Client, command, {
			expiresIn: 60, // 1 min
			signableHeaders: new Set(["content-type", "content-length"])
		});

		const fileUrl = `https://${bucket}.s3.${this.configService.get(
			"AWS_S3_REGION"
		)}.amazonaws.com/${key}`;

		return { uploadUrl, fileUrl, key };
	}

	/**
	 * Stores a file the server received itself (e.g. an email attachment) in
	 * the private bucket under the owner's namespace.
	 */
	async putPrivateObject(ownerId: string, body: Buffer, contentType: string, extension: string) {
		const key = `private/${ownerId}/${randomUUID()}.${extension}`;
		await this.s3Client.send(
			new PutObjectCommand({
				Bucket: this.privateBucket,
				Key: key,
				Body: body,
				ContentType: contentType,
				ContentLength: body.length,
				ACL: "private"
			})
		);
		const url = `https://${this.privateBucket}.s3.${this.configService.get(
			"AWS_S3_REGION"
		)}.amazonaws.com/${key}`;
		return { key, url };
	}

	/** Removes a private file for good (account deletion). Deleting a missing key is a no-op in S3. */
	async deletePrivateObject(key: string) {
		if (!key.startsWith("private/")) throw new BadRequestException("Only private files can be deleted here.");
		await this.s3Client.send(new DeleteObjectCommand({ Bucket: this.privateBucket, Key: key }));
	}

	/** Removes a public file for good (account deletion). Deleting a missing key is a no-op in S3. */
	async deletePublicObject(key: string) {
		if (!key.startsWith("public/")) throw new BadRequestException("Only public files can be deleted here.");
		await this.s3Client.send(new DeleteObjectCommand({ Bucket: this.publicBucket, Key: key }));
	}

	async getPresignedDownloadUrl(key: string, folder: "private" | "public", expiresIn = 60) {
		const bucket =
			folder === "private" ? this.privateBucket : this.publicBucket;

		const command = new GetObjectCommand({
			Bucket: bucket,
			Key: key
		});

		return await getSignedUrl(this.s3Client, command, { expiresIn });
	}

	async getAuthorizedPrivateDownloadUrl(key: string, user: User) {
		if (!key.startsWith("private/")) {
			throw new ForbiddenException("File access is not allowed.");
		}

		const userId = user._id.toString();
		// The key must also be minted for this landlord: a stored applicant key must not skip the share checks.
		// A key from before owner-scoped keys (private/<timestamp>-<name>) still opens, unless it is a user's own document.
		const ownsListingDocument = (isKeyOwnedBy(key, userId)
			|| (ownerIdFromKey(key) === null && !(await this.userModel.exists({ "documents.key": key }))))
			&& await this.listingModel.exists({
			landlord: userId,
			registerOfTitleKey: key
		});

		if (!ownsListingDocument && !(await this.isTenancyDocument(key, userId))) {
			const claimedOwnerIds = await this.userModel.distinct("_id", {
				"documents.key": key
			});

			// An owner-scoped key resolves only to the user it was issued to.
			// This makes the download path agree with the upload path, so a
			// claim recorded before keys were bound to a user cannot widen
			// access to somebody else's document.
			const keyOwnerId = ownerIdFromKey(key);
			const documentOwnerIds = keyOwnerId
				? claimedOwnerIds.filter(id => id.toString() === keyOwnerId)
				: claimedOwnerIds;

			// A key minted for this user is theirs even before it is filed on the profile.
			const isOwnDocument = keyOwnerId === userId || documentOwnerIds.some(
				id => id.toString() === userId
			);

			// Landlords see an applicant's files only while the student's share
			// is live: 14 days from sending the application, unless revoked.
			// Nobody else (another student, a stranger) can use a share.
			const activeShare = !isOwnDocument && user.role === Role.LANDLORD_AGENCY && documentOwnerIds.length > 0
				? await this.shareModel.exists({
					viewer: userId,
					owner: { $in: documentOwnerIds },
					revokedAt: null,
					expiresAt: { $gt: new Date() }
				})
				: null;

			if (!isOwnDocument && !activeShare) {
				throw new ForbiddenException("File access is not allowed.");
			}

			if (activeShare) {
				await this.recordAccess(documentOwnerIds, userId, key, activeShare._id);
			}
		}

		return this.getPresignedDownloadUrl(key, "private");
	}

	/**
	 * Tenancy files (agreement, deposit certificate, compliance certificates)
	 * belong to the tenancy, not to whoever uploaded them: the landlord and
	 * every tenant on it may open them.
	 */
	private async isTenancyDocument(key: string, userId: string) {
		if (!Types.ObjectId.isValid(userId)) return false;
		const member = {
			$or: [{ landlord: new Types.ObjectId(userId) }, { tenants: new Types.ObjectId(userId) }]
		};
		if (await this.tenancyModel.exists({ ...member, "documents.key": key })) return true;
		const contracts = await this.contractModel.find({ key }).select("tenancy").lean().exec();
		if (!contracts.length) return false;
		return Boolean(
			await this.tenancyModel.exists({ ...member, _id: { $in: contracts.map(contract => contract.tenancy) } })
		);
	}

	/** Logs a landlord opening a student's shared document. */
	private async recordAccess(owners: Types.ObjectId[], viewerId: string, key: string, share: Types.ObjectId) {
		const owner = owners.find(id => id.toString() !== viewerId) ?? owners[0];
		await this.accessModel.create({ owner, viewer: new Types.ObjectId(viewerId), key, share });
	}
}
