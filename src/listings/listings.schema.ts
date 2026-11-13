import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import { PropertyType } from "./enums/propertyType.enum";
import { FurnishingStatus } from "./enums/furnishingStatus.enum";
import { EpcRating } from "./enums/epcRating.enum";
import { Nation } from "./enums/nation.enum";
import { GuarantorCriterion } from "./enums/guarantor-criterion.enum";
import { ModerationStatus } from "./enums/moderation-status.enum";
import { DocumentType } from "../users/types/document-type";
import { PlanFrequency } from "../payments/payment.enums";
import { ApiProperty } from "@nestjs/swagger";
import { Expose, Transform } from "class-transformer";

/** What the landlord asks of applicant households; checked against each application. */
@Schema({ _id: false })
export class ListingCriteria {
	@Expose()
	@ApiProperty({ enum: GuarantorCriterion, default: GuarantorCriterion.UK_OR_SERVICE })
	@Prop({ enum: GuarantorCriterion, default: GuarantorCriterion.UK_OR_SERVICE })
	guarantor: GuarantorCriterion;

	@Expose()
	@ApiProperty({ default: false, description: "Applicants must upload a landlord, agent or character reference." })
	@Prop({ default: false })
	referencesRequired: boolean;

	@Expose()
	@ApiProperty({ required: false, description: "Largest household the landlord will accept." })
	@Prop()
	maxHousehold?: number;
}

/** Computed on read, never stored: a document an applicant needs before applying. */
export class RequiredDocumentInfo {
	@Expose()
	@ApiProperty({ example: "Identification" })
	label: string;

	@Expose()
	@ApiProperty({ enum: DocumentType, isArray: true, description: "Any one of these Seek Passport types satisfies it." })
	types: DocumentType[];
}

/** Computed on read, never stored: places left at one viewing time. */
export class ViewingSlotAvailability {
	@Expose()
	@ApiProperty({ type: String, format: "date-time" })
	at: Date;

	@Expose()
	@ApiProperty({ description: "Households that can still book this time (capacity minus open bookings)." })
	remaining: number;
}

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
	@ApiProperty({ enum: ModerationStatus, required: false, nullable: true, description: "Automatic check result; null until the listing is first checked." })
	@Prop({ type: String, enum: Object.values(ModerationStatus), default: null })
	moderationStatus?: ModerationStatus | null;

	@Expose()
	@ApiProperty({ type: [String], required: false, description: "What the landlord must fix before the listing goes live." })
	@Prop({ type: [String], default: [] })
	moderationReasons?: string[];

	@Prop({ type: Date, default: null })
	moderatedAt?: Date | null;

	/** AI checks that got no usable answer since the last edit; MAX_MODERATION_ATTEMPTS ends the wait. */
	@Prop({ type: Number, default: 0 })
	moderationAttempts?: number;

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
	@ApiProperty({ enum: Nation, default: Nation.ENGLAND })
	@Prop({ enum: Nation, default: Nation.ENGLAND })
	nation: Nation;

	@Expose()
	@ApiProperty({ default: false })
	@Prop({ default: false })
	billsIncluded: boolean;

	@Expose()
	@ApiProperty({ required: false, nullable: true, type: String, format: "date-time" })
	@Prop({ type: Date, default: null })
	gasSafetyExpiry?: Date | null;

	@Expose()
	@ApiProperty({ required: false, nullable: true, type: String, format: "date-time" })
	@Prop({ type: Date, default: null })
	eicrExpiry?: Date | null;

	@Expose()
	@ApiProperty({ required: false, nullable: true, type: String, format: "date-time" })
	@Prop({ type: Date, default: null })
	epcExpiry?: Date | null;

	@Expose()
	@ApiProperty({ required: false, nullable: true, type: String, format: "date-time" })
	@Prop({ type: Date, default: null })
	hmoLicenceExpiry?: Date | null;

	@Expose()
	@ApiProperty({ required: false })
	@Prop()
	licenceNumber?: string;

	@Expose()
	@ApiProperty({
		required: false,
		description: "Holding deposit per room, in whole pounds. Capped at one week's rent (rent x 12 / 52)."
	})
	@Prop()
	holdingDeposit?: number;

	@Expose()
	@ApiProperty({ type: ListingCriteria, required: false })
	@Prop({ type: Object })
	criteria?: ListingCriteria;

	@Expose()
	@ApiProperty({
		enum: PlanFrequency,
		isArray: true,
		description: "Rent plans tenants may pick. Monthly only for properties in England."
	})
	@Prop({ type: [String], enum: PlanFrequency, default: [PlanFrequency.MONTHLY] })
	paymentPlans: PlanFrequency[];

	@Expose()
	@ApiProperty({ type: [String], format: "date-time", description: "Viewing times the landlord offers." })
	@Prop({ type: [Date], default: [] })
	viewingSlots: Date[];

	@Expose()
	@ApiProperty({ default: 1, description: "Households that can book the same viewing slot." })
	@Prop({ default: 1, min: 1, max: 20 })
	viewingSlotCapacity: number;

	@Expose()
	@ApiProperty({
		type: ViewingSlotAvailability,
		isArray: true,
		required: false,
		description: "Places left per viewing slot. Returned by GET /listings/{id} and on the student's own applications."
	})
	viewingSlotAvailability?: ViewingSlotAvailability[];

	@Expose()
	@ApiProperty({
		type: RequiredDocumentInfo,
		isArray: true,
		required: false,
		description: "Documents a student must have uploaded to apply, from the requirements and criteria (no guarantor when the criterion is NONE). Returned by GET /listings/{id}."
	})
	requiredDocuments?: RequiredDocumentInfo[];

	@Expose()
	@ApiProperty({ default: 0, description: "Times the public listing page was opened." })
	@Prop({ default: 0 })
	views: number;

	@Expose()
	@ApiProperty({ required: false, description: "Last wizard step saved on a draft (1-4)." })
	@Prop()
	draftStep?: number;

	@Expose()
	@ApiProperty({
		required: false,
		nullable: true,
		description: "GeoJSON point, [lng, lat]. Null when the address could not be geocoded.",
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
	location?: {
		type: "Point";
		coordinates: [number, number]; // [lng, lat]
	} | null;
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
