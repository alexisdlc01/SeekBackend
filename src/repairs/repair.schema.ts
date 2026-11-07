import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { ApiProperty } from "@nestjs/swagger";
import { SchemaTypes, Types } from "mongoose";

export enum RepairStatus {
	OPEN = "OPEN",
	SCHEDULED = "SCHEDULED",
	FIXED = "FIXED"
}

@Schema({ timestamps: true })
export class Repair {
	@ApiProperty({ type: String })
	@Prop({ type: SchemaTypes.ObjectId, auto: true })
	_id: Types.ObjectId;

	@ApiProperty({ type: String })
	@Prop({ type: SchemaTypes.ObjectId, ref: "Tenancy", required: true, index: true })
	tenancy: Types.ObjectId;

	/** Denormalised so the landlord's list is one indexed query. */
	@ApiProperty({ type: String })
	@Prop({ type: SchemaTypes.ObjectId, ref: "User", required: true, index: true })
	landlord: Types.ObjectId;

	@ApiProperty({ type: String })
	@Prop({ type: SchemaTypes.ObjectId, ref: "User", required: true })
	reportedBy: Types.ObjectId;

	@ApiProperty({ example: "Boiler not heating water" })
	@Prop({ required: true, trim: true })
	title: string;

	@ApiProperty({ required: false })
	@Prop({ trim: true })
	description?: string;

	@ApiProperty({ enum: RepairStatus })
	@Prop({ enum: RepairStatus, default: RepairStatus.OPEN })
	status: RepairStatus;

	@ApiProperty({ type: String, format: "date-time", nullable: true })
	@Prop({ type: Date, default: null })
	scheduledFor: Date | null;

	@ApiProperty({ type: String, format: "date-time", nullable: true })
	@Prop({ type: Date, default: null })
	fixedAt: Date | null;

	@ApiProperty({ type: String, format: "date-time" })
	createdAt?: Date;
}

export const RepairSchema = SchemaFactory.createForClass(Repair);
