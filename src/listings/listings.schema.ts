import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import { PropertyType } from "./enums/propertyType.enum";
import { Amenity } from "./enums/amenity.enum";
import { FurnishingStatus } from "./enums/furnishingStatus.enum";
import { EpcRating } from "./enums/epcRating.enum";

@Schema()
export class Listing {
	@Prop({ type: SchemaTypes.ObjectId, auto: true })
	_id: Types.ObjectId;

	@Prop()
	propertyTitle: string;

	@Prop()
	sizeSqMeters: number;

	@Prop({ enum: PropertyType })
	propertyType: PropertyType;

	@Prop()
	bedroomsCount: number;

	@Prop()
	enSuiteBedroomCount: number;

	@Prop()
	propertyDesc: string;

	@Prop({ type: [String], enum: Amenity, default: [] })
	amenities: Amenity[];

	@Prop()
	streetAddress: string;

	@Prop()
	cityTown: string;

	@Prop()
	postcodeZIP: string;

	@Prop()
	country: string;

	@Prop()
	monthlyRent: number;

	@Prop()
	securityDeposit: number;

	@Prop()
	availableFrom: Date;

	@Prop()
	availableUntil: Date;

	@Prop({ enum: FurnishingStatus })
	furnishingStatus: FurnishingStatus;

	@Prop({ enum: EpcRating })
	epcRating: EpcRating;

	@Prop({ type: [String] })
	photos: string[];

	@Prop()
	videoTourLink: string;

	@Prop()
	floorPlanImage: string;
}

export const ListingSchema = SchemaFactory.createForClass(Listing);
