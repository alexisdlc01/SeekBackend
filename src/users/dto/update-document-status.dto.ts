import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsDateString, IsEnum, IsOptional, ValidateIf } from "class-validator";
import { DocumentStatus } from "../types/document-type";

export class UpdateDocumentStatusDto {
	@ApiProperty({ enum: DocumentStatus })
	@IsEnum(DocumentStatus)
	status: DocumentStatus;

	@ApiPropertyOptional({ type: String, format: "date-time", nullable: true })
	@IsOptional()
	@ValidateIf((_o, value) => value !== null)
	@IsDateString()
	expiresAt?: string | null;
}
