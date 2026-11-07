import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsEnum, IsOptional, IsString, IsUrl, MaxLength, MinLength } from "class-validator";
import { DocumentSource, TenancyDocumentType } from "../tenancy.enums";

export class AddTenancyDocumentDto {
	@ApiProperty({ enum: TenancyDocumentType })
	@IsEnum(TenancyDocumentType)
	type: TenancyDocumentType;

	@ApiProperty({ example: "Gas safety certificate 2026" })
	@IsString()
	@MinLength(2)
	@MaxLength(120)
	title: string;

	@ApiProperty()
	@IsUrl({ protocols: ["https"], require_protocol: true })
	url: string;

	@ApiPropertyOptional({ description: "Private upload key from /upload/presign." })
	@IsOptional()
	@IsString()
	@MaxLength(200)
	key?: string;

	@ApiPropertyOptional({ enum: DocumentSource, default: DocumentSource.UPLOAD })
	@IsOptional()
	@IsEnum(DocumentSource)
	source?: DocumentSource;
}
