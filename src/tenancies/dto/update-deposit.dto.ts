import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
	IsDateString,
	IsEnum,
	IsInt,
	IsOptional,
	IsString,
	MaxLength,
	Min,
	MinLength
} from "class-validator";
import { DepositScheme } from "../tenancy.enums";

export class UpdateDepositDto {
	@ApiProperty({ enum: DepositScheme })
	@IsEnum(DepositScheme)
	depositScheme: DepositScheme;

	@ApiProperty({ example: "DPS-4471-2209" })
	@IsString()
	@MinLength(3)
	@MaxLength(60)
	depositReference: string;

	@ApiPropertyOptional({ type: String, format: "date-time", description: "Defaults to now." })
	@IsOptional()
	@IsDateString()
	depositProtectedAt?: string;

	@ApiPropertyOptional({ type: String, format: "date-time", description: "When the deposit was received." })
	@IsOptional()
	@IsDateString()
	depositReceivedAt?: string;

	@ApiPropertyOptional({ description: "Correct the deposit per tenant, in pence." })
	@IsOptional()
	@IsInt()
	@Min(0)
	depositAmount?: number;
}

export class DepositReceivedDto {
	@ApiPropertyOptional({ type: String, format: "date-time", description: "Defaults to now." })
	@IsOptional()
	@IsDateString()
	receivedAt?: string;
}

export class PrescribedInfoDto {
	@ApiPropertyOptional({ type: String, format: "date-time", description: "Defaults to now." })
	@IsOptional()
	@IsDateString()
	sentAt?: string;
}
