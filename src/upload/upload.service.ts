import {
	BadRequestException,
	ForbiddenException,
	Injectable
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
	GetObjectCommand,
	PutObjectCommand,
	S3Client
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { randomUUID } from "node:crypto";
import { Listing } from "../listings/listings.schema";
import { User } from "../users/users.schema";
import { Application } from "../application/application.schema";
import { ApplicationStage } from "../application/enums/application-stage.enum";
import {
	ALLOWED_UPLOAD_TYPES,
	MAX_UPLOAD_BYTES
} from "./dto/presign.dto";
import { ownerIdFromKey } from "./object-key";

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
		@InjectModel(Application.name)
		private readonly applicationModel: Model<Application>
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

	async getPresignedDownloadUrl(key: string, folder: "private" | "public") {
		const bucket =
			folder === "private" ? this.privateBucket : this.publicBucket;

		const command = new GetObjectCommand({
			Bucket: bucket,
			Key: key
		});

		return await getSignedUrl(this.s3Client, command, { expiresIn: 60 });
	}

	async getAuthorizedPrivateDownloadUrl(key: string, user: User) {
		if (!key.startsWith("private/")) {
			throw new ForbiddenException("File access is not allowed.");
		}

		const userId = user._id.toString();
		const ownsListingDocument = await this.listingModel.exists({
			landlord: userId,
			registerOfTitleKey: key
		});

		if (!ownsListingDocument) {
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

			const canReviewApplicantDocument = documentOwnerIds.length > 0
				? await this.applicationModel.exists({
					landlord: userId,
					applicants: { $in: documentOwnerIds },
					stage: {
						$in: [
							ApplicationStage.SENT,
							ApplicationStage.ACCEPTED,
							ApplicationStage.REJECTED
						]
					}
				})
				: null;

			if (!canReviewApplicantDocument) {
				throw new ForbiddenException("File access is not allowed.");
			}
		}

		return this.getPresignedDownloadUrl(key, "private");
	}
}
