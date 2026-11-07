import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsEnum, IsMongoId, IsOptional, IsString, IsUrl, MaxLength, MinLength } from "class-validator";
import { DocumentSource } from "../../tenancies/tenancy.enums";

export class CreateContractDto {
	@ApiProperty()
	@IsMongoId()
	tenancy: string;

	@ApiProperty({ example: "Assured periodic tenancy agreement 2026" })
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
