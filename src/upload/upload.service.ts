import { ForbiddenException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
	GetObjectCommand,
	PutObjectCommand,
	S3Client
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { Listing } from "../listings/listings.schema";
import { User } from "../users/users.schema";
import { Application } from "../application/application.schema";
import { ApplicationStage } from "../application/enums/application-stage.enum";

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
		fileName: string,
		fileType: string,
		folder: "public" | "private"
	) {
		const bucket =
			folder === "private" ? this.privateBucket : this.publicBucket;

		const key = `${folder}/${Date.now()}-${fileName}`;

		const command =
			folder === "private"
				? new PutObjectCommand({
					Bucket: bucket,
					Key: key,
					ContentType: fileType,
					ACL: "private"
				})
				: new PutObjectCommand({
					Bucket: bucket,
					Key: key,
					ContentType: fileType
				});

		const uploadUrl = await getSignedUrl(this.s3Client, command, {
			expiresIn: 60 // 1 min
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
			const documentOwnerIds = await this.userModel.distinct("_id", {
				"documents.key": key
			});
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
