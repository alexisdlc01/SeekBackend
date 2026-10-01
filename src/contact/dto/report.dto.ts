import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, MaxLength, MinLength } from "class-validator";

export class ReportDto {
	@ApiProperty({ maxLength: 5000, description: "What happened." })
	@IsString()
	@MinLength(1)
	@MaxLength(5000)
	message: string;

	@ApiPropertyOptional({
		maxLength: 120,
		description: "The account being reported, as the reporter described it."
	})
	@IsOptional()
	@IsString()
	@MaxLength(120)
	reportedAccount?: string;
}
