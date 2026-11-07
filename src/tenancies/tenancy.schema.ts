import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { ApiProperty } from "@nestjs/swagger";
import { SchemaTypes, Types } from "mongoose";
import {
	DepositScheme,
	DocumentSource,
	TenancyDocumentType,
	TenancyStatus
} from "./tenancy.enums";

@Schema({ _id: true })
export class TenancyDocument {
	@ApiProperty({ type: String })
	_id?: Types.ObjectId;

	@ApiProperty({ enum: TenancyDocumentType })
	@Prop({ enum: TenancyDocumentType, required: true })
	type: TenancyDocumentType;

	@ApiProperty()
	@Prop({ required: true, trim: true })
	title: string;

	@ApiProperty()
	@Prop({ required: true })
	url: string;

	@ApiProperty({ required: false })
	@Prop()
	key?: string;

	@ApiProperty({ enum: DocumentSource })
	@Prop({ enum: DocumentSource, default: DocumentSource.UPLOAD })
	source: DocumentSource;

	@ApiProperty({ type: String, format: "date-time" })
	@Prop({ default: Date.now })
	addedAt: Date;
}

export const TenancyDocumentSchema = SchemaFactory.createForClass(TenancyDocument);

/**
 * A let between a landlord and one household. Money is stored in pence.
 * `monthlyRent` and `depositAmount` are what EACH tenant pays.
 */
@Schema({ timestamps: true })
export class Tenancy {
	@ApiProperty({ type: String })
	@Prop({ type: SchemaTypes.ObjectId, auto: true })
	_id: Types.ObjectId;

	@ApiProperty({ type: String })
	@Prop({ type: SchemaTypes.ObjectId, ref: "Listing", required: true, index: true })
	listing: Types.ObjectId;

	@ApiProperty({ type: String })
	@Prop({ type: SchemaTypes.ObjectId, ref: "User", required: true, index: true })
	landlord: Types.ObjectId;

	@ApiProperty({ type: [String] })
	@Prop({ type: [{ type: SchemaTypes.ObjectId, ref: "User" }], default: [], index: true })
	tenants: Types.ObjectId[];

	@ApiProperty({
		type: [String],
		description: "Students invited to a hand-made tenancy who have not accepted yet. They move to tenants on accept."
	})
	@Prop({ type: [{ type: SchemaTypes.ObjectId, ref: "User" }], default: [], index: true })
	pendingTenants: Types.ObjectId[];

	@ApiProperty({ type: String, required: false, nullable: true })
	@Prop({ type: SchemaTypes.ObjectId, ref: "Application", default: null })
	application?: Types.ObjectId | null;

	@ApiProperty({ type: String, format: "date-time" })
	@Prop({ required: true })
	startDate: Date;

	@ApiProperty({ type: String, format: "date-time", nullable: true })
	@Prop({ type: Date, default: null })
	endDate?: Date | null;

	@ApiProperty({ description: "Rolling (periodic) tenancy, the default under the Renters' Rights Act." })
	@Prop({ default: true })
	periodic: boolean;

	@ApiProperty({ description: "Rent per tenant per month, in pence." })
	@Prop({ required: true, min: 0 })
	monthlyRent: number;

	@ApiProperty({ description: "Deposit per tenant, in pence." })
	@Prop({ default: 0, min: 0 })
	depositAmount: number;

	@ApiProperty({ type: Number, nullable: true, description: "Energy fair-use allowance for the whole household, in pence per month. Usage above it is split between the tenants." })
	@Prop({ type: Number, default: null, min: 0 })
	energyAllowance: number | null;

	@ApiProperty({ enum: DepositScheme, nullable: true })
	@Prop({ type: String, enum: [...Object.values(DepositScheme), null], default: null })
	depositScheme: DepositScheme | null;

	@ApiProperty({ required: false })
	@Prop({ trim: true })
	depositReference?: string;

	@ApiProperty({ type: String, format: "date-time", nullable: true })
	@Prop({ type: Date, default: null })
	depositProtectedAt: Date | null;

	@ApiProperty({
		type: String,
		format: "date-time",
		nullable: true,
		description: "When the deposit reached the landlord. It must be protected within 30 days of this date."
	})
	@Prop({ type: Date, default: null })
	depositReceivedAt?: Date | null;

	@ApiProperty({
		type: String,
		format: "date-time",
		nullable: true,
		description: "When the landlord gave tenants the deposit's prescribed information."
	})
	@Prop({ type: Date, default: null })
	prescribedInfoSentAt?: Date | null;

	@ApiProperty({ type: [TenancyDocument] })
	@Prop({ type: [TenancyDocumentSchema], default: [] })
	documents: TenancyDocument[];

	@ApiProperty({ enum: TenancyStatus })
	@Prop({ enum: TenancyStatus, default: TenancyStatus.ACTIVE, index: true })
	status: TenancyStatus;

	@ApiProperty({ type: String, format: "date-time" })
	createdAt?: Date;
}

export const TenancySchema = SchemaFactory.createForClass(Tenancy);

// One tenancy per approved application, so approving twice is harmless.
TenancySchema.index(
	{ application: 1 },
	{ unique: true, partialFilterExpression: { application: { $type: "objectId" } } }
);
