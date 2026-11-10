import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
	IsDateString,
	IsEnum,
	IsInt,
	IsOptional,
	IsString,
	MaxLength,
	Min,
	MinLength,
	ValidateIf
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

	@ApiPropertyOptional({ type: Number, nullable: true, description: "Energy fair-use allowance for the household, in pence per month. null removes it.", example: 20000 })
	@IsOptional()
	@IsInt()
	@Min(0)
	energyAllowance?: number | null;
}

export class UpdateEnergyAllowanceDto {
	@ApiProperty({ type: Number, nullable: true, description: "Energy fair-use allowance for the household, in pence per month. null removes it.", example: 20000 })
	@ValidateIf((_, value) => value !== null)
	@IsInt()
	@Min(0)
	energyAllowance: number | null;
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
