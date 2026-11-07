import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
	ArrayMaxSize,
	IsArray,
	IsBoolean,
	IsInt,
	IsMongoId,
	IsOptional,
	IsString,
	IsUrl,
	Matches,
	MaxLength,
	Min,
	MinLength,
	ValidateNested
} from "class-validator";

export class DefaultContractDto {
	@ApiProperty()
	@IsMongoId()
	tenancy: string;
}

export class DocumentQueryDto {
	@ApiProperty({ description: "Signature from the contract's url." })
	@IsString()
	@Matches(/^[0-9a-f]{64}$/)
	sig: string;
}

export class InventoryItemDto {
	@ApiProperty({ example: "Bedroom 2" })
	@IsString()
	@MinLength(1)
	@MaxLength(60)
	room: string;

	@ApiProperty({ example: "Mattress" })
	@IsString()
	@MinLength(1)
	@MaxLength(80)
	item: string;

	@ApiProperty({ example: "Good, no stains" })
	@IsString()
	@MinLength(1)
	@MaxLength(300)
	condition: string;

	@ApiPropertyOptional({ type: [String] })
	@IsOptional()
	@IsArray()
	@ArrayMaxSize(20)
	@IsUrl({ protocols: ["https"], require_protocol: true }, { each: true })
	photoUrls?: string[];
}

export class InventoryDto {
	@ApiProperty({ type: [InventoryItemDto] })
	@IsArray()
	@ArrayMaxSize(300)
	@ValidateNested({ each: true })
	@Type(() => InventoryItemDto)
	items: InventoryItemDto[];
}

export class DeductionItemDto {
	@ApiProperty({ example: "Replace stained carpet in bedroom 2" })
	@IsString()
	@MinLength(2)
	@MaxLength(200)
	description: string;

	@ApiProperty({ description: "In pence.", example: 12000 })
	@IsInt()
	@Min(1)
	amount: number;

	@ApiPropertyOptional({ description: "Photo or invoice backing the deduction." })
	@IsOptional()
	@IsUrl({ protocols: ["https"], require_protocol: true })
	evidenceUrl?: string;
}

export class DeductionsDto {
	@ApiProperty({ type: [DeductionItemDto], description: "An empty list proposes returning the whole deposit." })
	@IsArray()
	@ArrayMaxSize(50)
	@ValidateNested({ each: true })
	@Type(() => DeductionItemDto)
	items: DeductionItemDto[];
}

export class RespondDeductionsDto {
	@ApiProperty({ description: "true to agree to the proposed deductions, false to dispute them." })
	@IsBoolean()
	accept: boolean;

	@ApiPropertyOptional({ example: "The carpet was already stained at check-in (photo 12)." })
	@IsOptional()
	@IsString()
	@MaxLength(500)
	note?: string;
}
