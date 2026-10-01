import { IsIn, IsEnum, IsInt, IsString, MaxLength, Min } from "class-validator";
import { Type } from "class-transformer";
import { ApiProperty } from "@nestjs/swagger";

export enum UploadFolder {
	PUBLIC = "public",
	PRIVATE = "private"
}

/**
 * Content types the platform accepts, mapped to the extension stored on the
 * object key. The presigned URL is signed with the requested content type, so
 * anything outside this list would otherwise be servable straight back from the
 * public bucket.
 */
export const ALLOWED_UPLOAD_TYPES: Readonly<Record<string, string>> = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/webp": "webp",
	"image/gif": "gif",
	"image/heic": "heic",
	"image/heif": "heif",
	"application/pdf": "pdf"
};

export const ALLOWED_UPLOAD_TYPE_LIST = Object.keys(ALLOWED_UPLOAD_TYPES);

/** Largest object a single presigned PUT may store, in bytes. */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

export class PresignReqDto {
	@ApiProperty({ enum: ALLOWED_UPLOAD_TYPE_LIST })
	@IsString()
	@IsIn(ALLOWED_UPLOAD_TYPE_LIST, {
		message: "fileType must be a supported image or PDF content type"
	})
	fileType: string;

	@ApiProperty({ enum: UploadFolder })
	@IsEnum(UploadFolder)
	folder: UploadFolder;

	/**
	 * Retained for client compatibility and logging only. The stored object key
	 * is generated server-side and never interpolates this value.
	 */
	@ApiProperty({
		description:
			"Original filename. Informational only — the stored object key is generated server-side."
	})
	@IsString()
	@MaxLength(255)
	filename: string;

	/**
	 * Signed into the upload URL as an exact Content-Length, so S3 rejects a
	 * body of any other size. Capped server-side at MAX_UPLOAD_BYTES.
	 */
	@ApiProperty({
		description: `Exact size of the file in bytes. Must be at most ${MAX_UPLOAD_BYTES}.`,
		maximum: MAX_UPLOAD_BYTES
	})
	@Type(() => Number)
	@IsInt()
	@Min(1)
	fileSize: number;
}

export class PresignResDto {
	@ApiProperty()
	@IsString()
	uploadUrl: string;

	@ApiProperty()
	@IsString()
	fileUrl: string;

	@ApiProperty()
	@IsString()
	key: string;
}
