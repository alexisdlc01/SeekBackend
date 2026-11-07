import { ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
	ArrayMaxSize,
	IsArray,
	IsBoolean,
	IsDateString,
	IsEnum,
	IsInt,
	IsNumber,
	IsOptional,
	IsString,
	Max,
	MaxLength,
	Min,
	ValidateIf,
	ValidateNested
} from "class-validator";
import { Nation } from "../enums/nation.enum";
import { GuarantorCriterion } from "../enums/guarantor-criterion.enum";
import { PlanFrequency } from "../../payments/payment.enums";

export class ListingCriteriaDto {
	@ApiPropertyOptional({ enum: GuarantorCriterion, default: GuarantorCriterion.UK_OR_SERVICE })
	@IsOptional()
	@IsEnum(GuarantorCriterion)
	guarantor?: GuarantorCriterion;

	@ApiPropertyOptional({ default: false })
	@IsOptional()
	@IsBoolean()
	referencesRequired?: boolean;

	@ApiPropertyOptional({ minimum: 1, maximum: 20 })
	@IsOptional()
	@IsInt()
	@Min(1)
	@Max(20)
	maxHousehold?: number;
}

/**
 * Nation, bills and compliance fields shared by the listing wizard and the
 * publish body. Every field is optional so existing clients keep working.
 * Dates accept an ISO string, or null to clear them.
 */
export class ListingExtrasDto {
	@ApiPropertyOptional({ enum: Nation, default: Nation.ENGLAND })
	@IsOptional()
	@IsEnum(Nation)
	nation?: Nation;

	@ApiPropertyOptional({ description: "Bills (energy, water, Wi-Fi) are included in the rent." })
	@IsOptional()
	@IsBoolean()
	billsIncluded?: boolean;

	@ApiPropertyOptional({ type: String, format: "date-time", nullable: true })
	@IsOptional()
	@ValidateIf((_o, value) => value !== null)
	@IsDateString()
	gasSafetyExpiry?: string | null;

	@ApiPropertyOptional({ type: String, format: "date-time", nullable: true })
	@IsOptional()
	@ValidateIf((_o, value) => value !== null)
	@IsDateString()
	eicrExpiry?: string | null;

	@ApiPropertyOptional({ type: String, format: "date-time", nullable: true })
	@IsOptional()
	@ValidateIf((_o, value) => value !== null)
	@IsDateString()
	epcExpiry?: string | null;

	@ApiPropertyOptional({ type: String, format: "date-time", nullable: true })
	@IsOptional()
	@ValidateIf((_o, value) => value !== null)
	@IsDateString()
	hmoLicenceExpiry?: string | null;

	@ApiPropertyOptional({ description: "HMO / selective licence or registration number." })
	@IsOptional()
	@IsString()
	@MaxLength(80)
	licenceNumber?: string;

	@ApiPropertyOptional({ description: "Holding deposit per room in whole pounds (max one week's rent)." })
	@IsOptional()
	@IsNumber()
	@Min(0)
	holdingDeposit?: number;

	@ApiPropertyOptional({ type: ListingCriteriaDto })
	@IsOptional()
	@ValidateNested()
	@Type(() => ListingCriteriaDto)
	criteria?: ListingCriteriaDto;

	@ApiPropertyOptional({
		enum: PlanFrequency,
		isArray: true,
		description: "Rent plans offered. Properties in England allow MONTHLY only."
	})
	@IsOptional()
	@IsArray()
	@ArrayMaxSize(3)
	@IsEnum(PlanFrequency, { each: true })
	paymentPlans?: PlanFrequency[];

	@ApiPropertyOptional({ type: [String], format: "date-time", description: "Viewing times offered to applicants." })
	@IsOptional()
	@IsArray()
	@ArrayMaxSize(40)
	@IsDateString({}, { each: true })
	viewingSlots?: string[];

	@ApiPropertyOptional({ default: 1, minimum: 1, maximum: 20, description: "Households that can book the same slot." })
	@IsOptional()
	@IsInt()
	@Min(1)
	@Max(20)
	viewingSlotCapacity?: number;
}
