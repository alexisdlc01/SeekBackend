import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import { FlagCategory } from "./enums/category";
import { FlagStatus } from "./enums/flag-status";
import { ApiProperty } from "@nestjs/swagger";

export const TriageCategory = ["THREATS_VIOLENCE", "FRAUD_SCAM", "HARASSMENT", "DISCRIMINATION", "INAPPROPRIATE", "SPAM", "OTHER"] as const;
export const TriageSeverity = ["low", "medium", "high"] as const;

export interface FlagTriage {
	category: (typeof TriageCategory)[number];
	severity: (typeof TriageSeverity)[number];
	summary: string;
	provider: string;
}

@Schema({ timestamps: true })
export class Flag {
	@ApiProperty({ type: String })
	@Prop({ type: SchemaTypes.ObjectId, auto: true })
	_id: Types.ObjectId;

	@ApiProperty({ enum: FlagStatus })
	@Prop({
		enum: FlagStatus,
		required: true,
		default: FlagStatus.UNDER_REVIEW
	})
	status: string;

	@ApiProperty({ enum: FlagCategory })
	@Prop({ enum: FlagCategory })
	category: string;

	@ApiProperty({ type: String })
	@Prop({ type: SchemaTypes.ObjectId, required: true, ref: "User" })
	reportedUser: Types.ObjectId;

	@ApiProperty({ type: String })
	@Prop({ type: SchemaTypes.ObjectId, required: true, ref: "User" })
	createdBy: Types.ObjectId;

	@ApiProperty()
	@Prop({ required: true })
	text: string;

	@ApiProperty({ required: false })
	@Prop()
	resolutionDate: Date;

	@ApiProperty({ type: String, nullable: true, required: false, description: "Seek support's reply to the reporter." })
	@Prop({ type: String, default: null })
	supportResponse: string | null;

	@ApiProperty({ required: false, nullable: true, description: "Automatic AI triage (admins only): category, severity and a short summary." })
	@Prop({ type: Object, default: null })
	triage?: FlagTriage | null;

	@ApiProperty({ type: String, format: "date-time" })
	createdAt: Date;
}

export const FlagSchema = SchemaFactory.createForClass(Flag);
