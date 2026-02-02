import { IsEnum, IsString } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export enum UploadFolder {
	PUBLIC = "public",
	PRIVATE = "private"
}

export class PresignReqDto {
	@ApiProperty()
	@IsString()
	fileType: string;

	@ApiProperty({ enum: UploadFolder })
	@IsEnum(UploadFolder)
	folder: UploadFolder;

	@ApiProperty()
	@IsString()
	filename: string;
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
