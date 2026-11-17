import { ApiProperty } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsString, MaxLength } from "class-validator";

export class UpdateBankTransferInstructionsDto {
	@ApiProperty({ maxLength: 1000, description: "Instructions for paying this tenancy by bank transfer." })
	@Transform(({ value }) => value?.trim())
	@IsString()
	@MaxLength(1000)
	bankTransferInstructions: string;
}
