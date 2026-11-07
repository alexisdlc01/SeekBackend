import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, MaxLength } from "class-validator";

export class RejectApplicationDto {
	@ApiPropertyOptional({ description: "Why the application was declined. Shown to the household.", maxLength: 500 })
	@IsOptional()
	@IsString()
	@MaxLength(500)
	reason?: string;
}
