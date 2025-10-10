import {
	IsEnum,
	IsNumber,
	IsOptional,
	IsString,
	IsArray,
	IsDateString
} from "class-validator";
import { PropertyType } from "../enums/propertyType.enum";
import { Amenity } from "../enums/amenity.enum";
import { FurnishingStatus } from "../enums/furnishingStatus.enum";
import { EpcRating } from "../enums/epcRating.enum";

export class CreateListingDto {
	@IsString() propertyTitle: string;
	@IsNumber() sizeSqMeters: number;
	@IsEnum(PropertyType) propertyType: PropertyType;
	@IsString() streetAddress: string;
	@IsString() cityTown: string;
	@IsString() postcodeZIP: string;
	@IsString() country: string;
	@IsNumber() bedroomsCount: number;
	@IsNumber() enSuiteBedroomCount: number;
	@IsNumber() bathrooms: number;
	@IsString() propertyDesc: string;
	@IsNumber() monthlyRent: number;
	@IsNumber() securityDeposit: number;
	@IsDateString() availableFrom: string;
	@IsDateString() availableUntil: string;
	@IsString() registerOfTitleKey: string;
	@IsEnum(FurnishingStatus) furnishingStatus: FurnishingStatus;
	@IsOptional() @IsEnum(EpcRating) epcRating: EpcRating;
	@IsArray() photos: string[];
	@IsOptional() @IsString() videoTourLink?: string;
	@IsOptional() @IsString() floorPlanImage?: string;

	@IsOptional()
	@IsArray()
	@IsString({ each: true })
	amenities: string[];
}

export class Step1ListingDto {
	@IsOptional() @IsString() propertyTitle: string;
	@IsOptional() @IsNumber() sizeSqMeters: number;
	@IsOptional() @IsEnum(PropertyType) propertyType: PropertyType;
	@IsOptional() @IsString() streetAddress: string;
	@IsOptional() @IsString() cityTown: string;
	@IsOptional() @IsString() postcodeZIP: string;
	@IsOptional() @IsString() country: string;
	@IsOptional() @IsNumber() bedroomsCount: number;
	@IsOptional() @IsNumber() enSuiteBedroomCount: number;
	@IsOptional() @IsNumber() bathrooms: number;
	@IsOptional() @IsString() propertyDesc: string;
	@IsOptional() @IsNumber() monthlyRent: number;
	@IsOptional() @IsNumber() securityDeposit: number;
	@IsOptional() @IsDateString() availableFrom: string;
	@IsOptional() @IsDateString() availableUntil: string;
	@IsOptional() @IsString() registerOfTitleKey: string;
}

export class Step2ListingDto {
	@IsOptional() @IsEnum(FurnishingStatus) furnishingStatus: FurnishingStatus;
	@IsOptional() @IsEnum(EpcRating) epcRating: EpcRating;

	@IsOptional()
	@IsArray()
	@IsString({ each: true })
	amenities: string[];
}

export class Step3ListingDto {
	@IsOptional() @IsArray() photos: string[];
	@IsOptional() @IsString() videoTourLink?: string;
	@IsOptional() @IsString() floorPlanImage?: string;
}
