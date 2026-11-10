import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { ApiProperty } from "@nestjs/swagger";
import { SchemaTypes, Types } from "mongoose";
import { PaymentKind, PaymentProvider, PaymentStatus, PayoutStatus } from "./payment.enums";

/** One rent instalment, or a holding deposit. Amounts are pence. */
@Schema({ timestamps: true })
export class Payment {
	@ApiProperty({ type: String })
	@Prop({ type: SchemaTypes.ObjectId, auto: true })
	_id: Types.ObjectId;

	@ApiProperty({ enum: PaymentKind, default: PaymentKind.RENT })
	@Prop({ enum: PaymentKind, default: PaymentKind.RENT })
	kind: PaymentKind;

	@ApiProperty({ type: String, nullable: true, description: "Null for a holding deposit (no tenancy yet)." })
	@Prop({
		type: SchemaTypes.ObjectId,
		ref: "Tenancy",
		required(this: Payment) {
			return this.kind !== PaymentKind.HOLDING_DEPOSIT;
		}
	})
	tenancy: Types.ObjectId;

	@ApiProperty({ type: String, required: false, description: "The application a holding deposit secures." })
	@Prop({ type: SchemaTypes.ObjectId, ref: "Application", index: true })
	application?: Types.ObjectId;

	@ApiProperty({ type: String })
	@Prop({ type: SchemaTypes.ObjectId, ref: "User", required: true })
	tenant: Types.ObjectId;

	@ApiProperty({ type: String })
	@Prop({ type: SchemaTypes.ObjectId, ref: "User", required: true })
	landlord: Types.ObjectId;

	@ApiProperty({ description: "What the tenant pays, in pence." })
	@Prop({ required: true, min: 0 })
	amount: number;

	@ApiProperty({ description: "Seek's 1% fee, in pence, taken from the landlord's payout." })
	@Prop({ required: true, min: 0 })
	seekFee: number;

	@ApiProperty({ description: "What the landlord receives, in pence." })
	@Prop({ required: true, min: 0 })
	payout: number;

	@ApiProperty({ required: false, description: "Paid holding deposit counted toward this rent (Tenant Fees Act), pence. `amount` is already reduced by it." })
	@Prop({ default: 0, min: 0 })
	holdingDepositCredit?: number;

	@ApiProperty({ description: "Months of rent this payment covers." })
	@Prop({ default: 1, min: 1 })
	coversMonths: number;

	@ApiProperty({ enum: PaymentStatus })
	@Prop({ enum: PaymentStatus, default: PaymentStatus.SCHEDULED })
	status: PaymentStatus;

	@ApiProperty({ type: String, format: "date-time" })
	@Prop({ required: true })
	dueDate: Date;

	@ApiProperty({ type: String, format: "date-time", nullable: true })
	@Prop({ type: Date, default: null })
	paidAt: Date | null;

	@ApiProperty({ enum: PaymentProvider, nullable: true })
	@Prop({ type: String, enum: [...Object.values(PaymentProvider), null], default: null })
	provider: PaymentProvider | null;

	@ApiProperty({ required: false, nullable: true })
	@Prop({ type: String, default: null })
	providerRef: string | null;

	@ApiProperty({
		enum: PayoutStatus,
		required: false,
		nullable: true,
		description: "HELD: paid by card while the landlord's payouts weren't set up, so Seek holds the money. TRANSFERRED: Seek has since sent it to the landlord. Null: it goes straight to the landlord."
	})
	@Prop({ type: String, enum: [...Object.values(PayoutStatus), null], default: null })
	payoutStatus?: PayoutStatus | null;

	@ApiProperty({ required: false, nullable: true, description: "Stripe transfer that released a held payment." })
	@Prop({ type: String, default: null })
	transferRef?: string | null;

	@ApiProperty({ description: "Reminders Seek has sent the tenant for this payment." })
	@Prop({ default: 0, min: 0 })
	remindersSent: number;

	@ApiProperty({ type: String, format: "date-time", nullable: true })
	@Prop({ type: Date, default: null })
	lastReminderAt: Date | null;

	@ApiProperty({ description: "A paid holding deposit the landlord must refund within 7 days (Tenant Fees Act), e.g. after declining the household." })
	@Prop({ default: false })
	refundDue: boolean;
}

export const PaymentSchema = SchemaFactory.createForClass(Payment);

PaymentSchema.index({ tenant: 1, dueDate: 1 });
PaymentSchema.index({ landlord: 1, dueDate: 1 });
PaymentSchema.index({ tenancy: 1, tenant: 1, dueDate: 1 });
PaymentSchema.index({ status: 1, dueDate: 1 });
PaymentSchema.index({ providerRef: 1 }, { sparse: true });
PaymentSchema.index({ payoutStatus: 1, status: 1 }, { partialFilterExpression: { payoutStatus: "HELD" } });
