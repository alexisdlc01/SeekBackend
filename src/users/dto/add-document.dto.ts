import {
	IsDateString,
	IsEnum,
	IsOptional,
	IsString,
	IsUrl,
	MaxLength
} from "class-validator";
import { DocumentType } from "../types/document-type";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class AddDocumentDto {
	@ApiProperty({ enum: DocumentType })
	@IsEnum(DocumentType)
	documentType: DocumentType;

	@ApiProperty()
	@IsUrl()
	url: string;

	@ApiProperty({
		description:
			"Object key returned by /upload/presign. Must have been issued to the calling account."
	})
	@IsString()
	key: string;

	@ApiPropertyOptional({ description: "Shown in the passport, e.g. file name or share code." })
	@IsOptional()
	@IsString()
	@MaxLength(120)
	label?: string;

	@ApiPropertyOptional({ type: String, format: "date-time" })
	@IsOptional()
	@IsDateString()
	expiresAt?: string;
}
