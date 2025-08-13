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
	@IsNumber() bedroomsCount: number;
	@IsNumber() enSuiteBedroomCount: number;
	@IsString() propertyDesc: string;
	@IsArray() @IsEnum(Amenity, { each: true }) amenities: Amenity[];
	@IsString() streetAddress: string;
	@IsString() cityTown: string;
	@IsString() postcodeZIP: string;
	@IsString() country: string;
	@IsNumber() monthlyRent: number;
	@IsNumber() securityDeposit: number;
	@IsDateString() availableFrom: string;
	@IsDateString() availableUntil: string;
	@IsEnum(FurnishingStatus) furnishingStatus: FurnishingStatus;
	@IsEnum(EpcRating) epcRating: EpcRating;
	@IsArray() photos: string[];
	@IsOptional() @IsString() videoTourLink?: string;
	@IsOptional() @IsString() floorPlanImage?: string;
}
