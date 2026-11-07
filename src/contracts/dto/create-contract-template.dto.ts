import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, IsUrl, MaxLength, MinLength } from "class-validator";

export class CreateContractTemplateDto {
	@ApiProperty({ example: "Standard assured shorthold tenancy" })
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
}
