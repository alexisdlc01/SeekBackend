import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import { PropertyType } from "./enums/propertyType.enum";
import { FurnishingStatus } from "./enums/furnishingStatus.enum";
import { EpcRating } from "./enums/epcRating.enum";
import { ApiProperty } from "@nestjs/swagger";

@Schema({ timestamps: true })
export class Listing {
	@Prop({ type: SchemaTypes.ObjectId, auto: true })
	@ApiProperty({ type: String })
	_id: Types.ObjectId;

	@Prop({
		type: SchemaTypes.ObjectId,
		ref: "User",
		required: true,
		index: true
	})
	@ApiProperty({ type: String })
	landlord: Types.ObjectId;

	@ApiProperty()
	@Prop() propertyTitle?: string;
	@ApiProperty()
	@Prop() numOfPeople?: number;
	@ApiProperty()
	@Prop() sizeSqMeters?: number;
	@ApiProperty({ enum: PropertyType })
	@Prop({ enum: PropertyType }) propertyType?: PropertyType;
	@ApiProperty()
	@Prop() bedroomsCount?: number;
	@ApiProperty()
	@Prop() enSuiteBedroomCount?: number;
	@ApiProperty()
	@Prop() bathrooms?: number;
	@ApiProperty()
	@Prop() registerOfTitleKey?: string;
	@ApiProperty()
	@Prop() propertyDesc?: string;
	@ApiProperty()
	@Prop({ type: [String], default: [] }) amenities?: string[];
	@ApiProperty()
	@Prop() streetAddress?: string;
	@ApiProperty()
	@Prop() cityTown?: string;
	@ApiProperty()
	@Prop() postcodeZIP?: string;
	@ApiProperty()
	@Prop() country?: string;
	@ApiProperty()
	@Prop() monthlyRent?: number;
	@ApiProperty()
	@Prop() securityDeposit?: number;
	@ApiProperty()
	@Prop() availableFrom?: Date;
	@ApiProperty()
	@Prop() availableUntil?: Date;
	@ApiProperty({ enum: FurnishingStatus })
	@Prop({ enum: FurnishingStatus }) furnishingStatus?: FurnishingStatus;
	@ApiProperty({ enum: EpcRating })
	@Prop({ enum: EpcRating }) epcRating?: EpcRating;
	@ApiProperty()
	@Prop({ type: [String] }) photos?: string[];
	@ApiProperty()
	@Prop() videoTourLink?: string;

	@ApiProperty()
	@Prop() floorPlanImage?: string;

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

	@ApiProperty()
	@Prop({ default: false }) isVerified: boolean;

	@ApiProperty()
	@Prop({ default: true }) isDraft: boolean;

	@ApiProperty()
	@Prop({ default: Date.now }) lastUpdated: Date;
}

export const ListingSchema = SchemaFactory.createForClass(Listing);

ListingSchema.index(
	{ createdAt: 1 },
	{
		expireAfterSeconds: 60 * 60 * 24 * 7, // 7 days
		partialFilterExpression: { isDraft: true }
	}
);
