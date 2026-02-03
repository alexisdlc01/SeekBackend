import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import { PropertyType } from "./enums/propertyType.enum";
import { FurnishingStatus } from "./enums/furnishingStatus.enum";
import { EpcRating } from "./enums/epcRating.enum";
import { ApiProperty } from "@nestjs/swagger";
import { Expose, Transform } from "class-transformer";

@Schema({ timestamps: true })
export class Listing {
	@Expose()
	@Prop({ type: SchemaTypes.ObjectId, auto: true })
	@ApiProperty({ type: String })
	@Transform(({ obj }) => obj?._id.toString())
	_id: Types.ObjectId;

	@Expose()
	@Prop({
		type: SchemaTypes.ObjectId,
		ref: "User",
		required: true,
		index: true
	})
	@ApiProperty({ type: String })
	landlord: Types.ObjectId;

	@Expose()
	@ApiProperty()
	@Prop()
	propertyTitle?: string;

	@Expose()
	@ApiProperty()
	@Prop()
	numOfPeople?: number;

	@Expose()
	@ApiProperty()
	@Prop()
	sizeSqMeters?: number;

	@Expose()
	@ApiProperty({ enum: PropertyType })
	@Prop({ enum: PropertyType })
	propertyType?: PropertyType;

	@Expose()
	@ApiProperty()
	@Prop()
	bedroomsCount?: number;

	@Expose()
	@ApiProperty()
	@Prop()
	enSuiteBedroomCount?: number;

	@Expose()
	@ApiProperty()
	@Prop()
	bathrooms?: number;

	@Expose()
	@ApiProperty()
	@Prop()
	registerOfTitleKey?: string;

	@Expose()
	@ApiProperty()
	@Prop()
	registrationNumber?: string;

	@Expose()
	@ApiProperty()
	@Prop()
	propertyDesc?: string;

	@Expose()
	@ApiProperty()
	@Prop({ type: [String], default: [] })
	amenities?: string[];

	@Expose()
	@ApiProperty()
	@Prop()
	streetAddress?: string;

	@Expose()
	@ApiProperty()
	@Prop()
	cityTown?: string;

	@Expose()
	@ApiProperty()
	@Prop()
	postcodeZIP?: string;

	@Expose()
	@ApiProperty()
	@Prop()
	country?: string;

	@Expose()
	@ApiProperty()
	@Prop()
	monthlyRent?: number;

	@Expose()
	@ApiProperty()
	@Prop()
	securityDeposit?: number;

	@Expose()
	@ApiProperty()
	@Prop()
	availableFrom?: Date;

	@Expose()
	@ApiProperty()
	@Prop()
	availableUntil?: Date;

	@Expose()
	@ApiProperty({ enum: FurnishingStatus })
	@Prop({ enum: FurnishingStatus })
	furnishingStatus?: FurnishingStatus;

	@Expose()
	@ApiProperty({ enum: EpcRating })
	@Prop({ enum: EpcRating })
	epcRating?: EpcRating;

	@Expose()
	@ApiProperty()
	@Prop({ type: [String] })
	photos?: string[];

	@Expose()
	@ApiProperty()
	@Prop()
	videoTourLink?: string;

	@Expose()
	@ApiProperty()
	@Prop()
	floorPlanImage?: string;

	@Expose()
	@ApiProperty()
	@Prop({
		type: [
			{
				name: String,
				desc: String,
				required: Boolean
			}
		],
		default: []
	})
	requirements?: {
		name: string;
		desc: string;
		required: boolean;
	}[];

	@Expose()
	@ApiProperty()
	@Prop({ default: false })
	isVerified: boolean;

	@Expose()
	@ApiProperty()
	@Prop({ default: true })
	isDraft: boolean;

	@Expose()
	@ApiProperty()
	@Prop({ default: Date.now })
	lastUpdated: Date;

	@Expose()
	@ApiProperty({ type: String, isArray: true })
	@Prop({ type: [{ type: Types.ObjectId, ref: "User" }], default: [] })
	likedBy: Types.ObjectId[];

	@Expose()
	@Prop({
		type: {
			type: String
		}
	})
	formatted_address: string;

	@Expose()
	@ApiProperty({
		example: { type: "Point", coordinates: [-3.1883, 55.9533] }
	})
	@Prop({
		type: {
			type: String,
			enum: ["Point"]
		},
		coordinates: {
			type: [Number]
		}
	})
	location: {
		type: "Point";
		coordinates: [number, number]; // [lng, lat]
	};
}

export const ListingSchema = SchemaFactory.createForClass(Listing);

ListingSchema.index(
	{ createdAt: 1 },
	{
		expireAfterSeconds: 60 * 60 * 24 * 7, // 7 days
		partialFilterExpression: { isDraft: true }
	}
);

ListingSchema.index({ location: "2dsphere" });
