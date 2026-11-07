import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
	ArrayMaxSize,
	ArrayMinSize,
	IsArray,
	IsBoolean,
	IsDateString,
	IsEnum,
	IsInt,
	IsMongoId,
	IsOptional,
	IsString,
	MaxLength,
	Min
} from "class-validator";
import { DepositScheme } from "../tenancy.enums";

export class CreateTenancyDto {
	@ApiProperty({ description: "Listing id (must be yours)." })
	@IsMongoId()
	listing: string;

	@ApiPropertyOptional({
		type: [String],
		description:
			"Student user ids to invite, for a tenancy made by hand. Each must accept before rent is scheduled. Ignored when application is given."
	})
	@IsOptional()
	@IsArray()
	@ArrayMinSize(1)
	@ArrayMaxSize(20)
	@IsMongoId({ each: true })
	tenants?: string[];

	@ApiPropertyOptional({
		description: "ACCEPTED application on your listing this tenancy comes from. Its applicants become the tenants."
	})
	@IsOptional()
	@IsMongoId()
	application?: string;

	@ApiProperty({ type: String, format: "date-time" })
	@IsDateString()
	startDate: string;

	@ApiPropertyOptional({ type: String, format: "date-time" })
	@IsOptional()
	@IsDateString()
	endDate?: string;

	@ApiPropertyOptional({ default: true })
	@IsOptional()
	@IsBoolean()
	periodic?: boolean;

	@ApiProperty({ description: "Rent per tenant per month, in pence.", example: 69500 })
	@IsInt()
	@Min(0)
	monthlyRent: number;

	@ApiPropertyOptional({ description: "Deposit per tenant, in pence.", example: 80100 })
	@IsOptional()
	@IsInt()
	@Min(0)
	depositAmount?: number;

	@ApiPropertyOptional({ type: Number, description: "Energy fair-use allowance for the household, in pence per month.", example: 20000 })
	@IsOptional()
	@IsInt()
	@Min(0)
	energyAllowance?: number;

	@ApiPropertyOptional({ enum: DepositScheme })
	@IsOptional()
	@IsEnum(DepositScheme)
	depositScheme?: DepositScheme;

	@ApiPropertyOptional()
	@IsOptional()
	@IsString()
	@MaxLength(60)
	depositReference?: string;

	@ApiPropertyOptional({ type: String, format: "date-time" })
	@IsOptional()
	@IsDateString()
	depositProtectedAt?: string;

	@ApiPropertyOptional({ type: String, format: "date-time", description: "When the deposit was received." })
	@IsOptional()
	@IsDateString()
	depositReceivedAt?: string;
}
