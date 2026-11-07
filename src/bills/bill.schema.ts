import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { ApiProperty } from "@nestjs/swagger";
import { SchemaTypes, Types } from "mongoose";

export enum BillCategory {
	ENERGY = "ENERGY",
	WATER = "WATER",
	BROADBAND = "BROADBAND",
	COUNCIL_TAX = "COUNCIL_TAX",
	TV_LICENCE = "TV_LICENCE",
	OTHER = "OTHER"
}

export enum BillStatus {
	DUE = "DUE",
	PAID = "PAID"
}

export enum BillSource {
	EMAIL = "EMAIL",
	MANUAL = "MANUAL"
}

/** A household bill. Amount is the whole bill in pence. */
@Schema({ timestamps: true })
export class Bill {
	@ApiProperty({ type: String })
	@Prop({ type: SchemaTypes.ObjectId, auto: true })
	_id: Types.ObjectId;

	@ApiProperty({ type: String })
	@Prop({ type: SchemaTypes.ObjectId, ref: "Tenancy", required: true, index: true })
	tenancy: Types.ObjectId;

	@ApiProperty({ example: "Octopus Energy" })
	@Prop({ required: true, trim: true })
	provider: string;

	@ApiProperty({ enum: BillCategory })
	@Prop({ enum: BillCategory, default: BillCategory.OTHER })
	category: BillCategory;

	@ApiProperty({ description: "Whole bill, in pence." })
	@Prop({ required: true, min: 0 })
	amount: number;

	@ApiProperty({ type: String, format: "date-time", nullable: true })
	@Prop({ type: Date, default: null })
	periodStart: Date | null;

	@ApiProperty({ type: String, format: "date-time", nullable: true })
	@Prop({ type: Date, default: null })
	periodEnd: Date | null;

	@ApiProperty({ type: String, format: "date-time", nullable: true })
	@Prop({ type: Date, default: null })
	dueDate: Date | null;

	@ApiProperty({ description: "Covered by the rent: nobody owes a share." })
	@Prop({ default: false })
	includedInRent: boolean;

	@ApiProperty({ type: [String], description: "Tenants who share this bill." })
	@Prop({ type: [{ type: SchemaTypes.ObjectId, ref: "User" }], default: [] })
	splitBetween: Types.ObjectId[];

	@ApiProperty({ type: [String], description: "Tenants who have paid their share. The bill is PAID once everyone has." })
	@Prop({ type: [{ type: SchemaTypes.ObjectId, ref: "User" }], default: [] })
	paidShares: Types.ObjectId[];

	@ApiProperty({ type: String, nullable: true, description: "Tenant who fronted the whole bill (a shared extra); the others owe them their share." })
	@Prop({ type: SchemaTypes.ObjectId, ref: "User", default: null })
	paidBy: Types.ObjectId | null;

	@ApiProperty({ enum: BillStatus })
	@Prop({ enum: BillStatus, default: BillStatus.DUE })
	status: BillStatus;

	@ApiProperty({ enum: BillSource })
	@Prop({ enum: BillSource, default: BillSource.MANUAL })
	source: BillSource;

	@ApiProperty({ type: String, format: "date-time", nullable: true })
	@Prop({ type: Date, default: null })
	paidAt: Date | null;
}

export const BillSchema = SchemaFactory.createForClass(Bill);
