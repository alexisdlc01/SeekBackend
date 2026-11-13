import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { ApiProperty } from "@nestjs/swagger";
import { SchemaTypes, Types } from "mongoose";
import { DocumentSource } from "../tenancies/tenancy.enums";

export enum ContractStatus {
	DRAFT = "DRAFT",
	SENT = "SENT",
	SIGNED = "SIGNED"
}

@Schema({ _id: false })
export class ContractSignature {
	@ApiProperty({ type: String })
	@Prop({ type: SchemaTypes.ObjectId, ref: "User", required: true })
	user: Types.ObjectId;

	@ApiProperty({ type: String, format: "date-time" })
	@Prop({ required: true })
	signedAt: Date;
}

export const ContractSignatureSchema = SchemaFactory.createForClass(ContractSignature);

/** Seek's built-in agreements, one per nation whose law they follow. */
export enum ContractTemplateKind {
	ENGLAND_ASSURED_PERIODIC = "ENGLAND_ASSURED_PERIODIC",
	WALES_STANDARD_OCCUPATION = "WALES_STANDARD_OCCUPATION"
}

export enum DeductionStatus {
	PROPOSED = "PROPOSED",
	ACCEPTED = "ACCEPTED",
	DISPUTED = "DISPUTED"
}

@Schema({ _id: false })
export class InventoryItem {
	@ApiProperty({ example: "Bedroom 2" })
	@Prop({ required: true, trim: true })
	room: string;

	@ApiProperty({ example: "Mattress" })
	@Prop({ required: true, trim: true })
	item: string;

	@ApiProperty({ example: "Good, no stains" })
	@Prop({ required: true, trim: true })
	condition: string;

	@ApiProperty({ type: [String] })
	@Prop({ type: [String], default: [] })
	photoUrls: string[];
}

@Schema({ _id: false })
export class Inventory {
	@ApiProperty({ type: [InventoryItem] })
	@Prop({ type: [SchemaFactory.createForClass(InventoryItem)], default: [] })
	items: InventoryItem[];

	@ApiProperty({ type: String, format: "date-time" })
	@Prop({ required: true })
	recordedAt: Date;
}

@Schema({ _id: false })
export class DeductionItem {
	@ApiProperty({ example: "Replace stained carpet in bedroom 2" })
	@Prop({ required: true, trim: true })
	description: string;

	@ApiProperty({ description: "In pence." })
	@Prop({ required: true, min: 1 })
	amount: number;

	@ApiProperty({ required: false, description: "Photo or invoice backing the deduction." })
	@Prop()
	evidenceUrl?: string;
}

@Schema({ _id: false })
export class DeductionResponse {
	@ApiProperty({ type: String })
	@Prop({ type: SchemaTypes.ObjectId, ref: "User", required: true })
	user: Types.ObjectId;

	@ApiProperty()
	@Prop({ required: true })
	accepted: boolean;

	@ApiProperty({ required: false })
	@Prop({ trim: true })
	note?: string;

	@ApiProperty({ type: String, format: "date-time" })
	@Prop({ required: true })
	at: Date;
}

/** End-of-tenancy deductions the landlord proposes from the joint deposit. */
@Schema({ _id: false })
export class Deductions {
	@ApiProperty({ type: [DeductionItem] })
	@Prop({ type: [SchemaFactory.createForClass(DeductionItem)], default: [] })
	items: DeductionItem[];

	@ApiProperty({ description: "Sum of the items, in pence. Never more than the household's deposit." })
	@Prop({ required: true, min: 0 })
	total: number;

	@ApiProperty({ enum: DeductionStatus, description: "ACCEPTED once every tenant agrees; DISPUTED as soon as one disagrees." })
	@Prop({ enum: DeductionStatus, default: DeductionStatus.PROPOSED })
	status: DeductionStatus;

	@ApiProperty({ type: [DeductionResponse] })
	@Prop({ type: [SchemaFactory.createForClass(DeductionResponse)], default: [] })
	responses: DeductionResponse[];

	@ApiProperty({ type: String, format: "date-time" })
	@Prop({ required: true })
	proposedAt: Date;
}

@Schema({ timestamps: true })
export class Contract {
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

	@ApiProperty({ enum: ContractStatus })
	@Prop({ enum: ContractStatus, default: ContractStatus.DRAFT })
	status: ContractStatus;

	@ApiProperty({ type: [ContractSignature] })
	@Prop({ type: [ContractSignatureSchema], default: [] })
	signatures: ContractSignature[];

	@ApiProperty({ type: String, format: "date-time", nullable: true })
	@Prop({ type: Date, default: null })
	sentAt: Date | null;

	@ApiProperty({ type: String, format: "date-time", nullable: true })
	@Prop({ type: Date, default: null })
	signedAt: Date | null;

	@ApiProperty({ type: String, format: "date-time", nullable: true, description: "Last signing reminder sent to the tenants." })
	@Prop({ type: Date, default: null })
	lastRemindedAt: Date | null;

	/** Automatic (daily sweep) reminders sent so far; the sweep stops at MAX_AUTO_REMINDERS. */
	@Prop({ type: Number, default: 0 })
	autoReminderCount: number;

	@ApiProperty({ enum: ContractTemplateKind, nullable: true, description: "Set when the contract is Seek's built-in agreement." })
	@Prop({ type: String, enum: [...Object.values(ContractTemplateKind), null], default: null })
	templateKind: ContractTemplateKind | null;

	@ApiProperty({ type: String, nullable: true, description: "The deposit's prescribed information (HTML), for Seek agreements." })
	@Prop({ type: String, default: null })
	prescribedInformationUrl: string | null;

	@ApiProperty({ type: Inventory, nullable: true, description: "Check-in inventory." })
	@Prop({ type: SchemaFactory.createForClass(Inventory), default: null })
	inventory: Inventory | null;

	@ApiProperty({ type: Deductions, nullable: true, description: "Proposed end-of-tenancy deductions." })
	@Prop({ type: SchemaFactory.createForClass(Deductions), default: null })
	deductions: Deductions | null;
}

export const ContractSchema = SchemaFactory.createForClass(Contract);
