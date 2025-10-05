import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
	GetObjectCommand,
	PutObjectCommand,
	S3Client
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

@Injectable()
export class UploadService {
	private readonly s3Client: S3Client;
	private readonly publicBucket: string;
	private readonly privateBucket: string;

	constructor(private readonly configService: ConfigService) {
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

		const command = new PutObjectCommand({
			Bucket: bucket,
			Key: key,
			ContentType: fileType,
			ACL: folder === "private" ? "private" : "public-read"
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
}
