import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { ApiProperty } from "@nestjs/swagger";
import { SchemaTypes, Types } from "mongoose";
import { PlanFrequency } from "./payment.enums";

/** How one tenant chooses to pay their share of the rent. */
@Schema({ timestamps: true })
export class RentPlan {
	@ApiProperty({ type: String })
	@Prop({ type: SchemaTypes.ObjectId, auto: true })
	_id: Types.ObjectId;

	@ApiProperty({ type: String })
	@Prop({ type: SchemaTypes.ObjectId, ref: "Tenancy", required: true })
	tenancy: Types.ObjectId;

	@ApiProperty({ type: String })
	@Prop({ type: SchemaTypes.ObjectId, ref: "User", required: true })
	tenant: Types.ObjectId;

	@ApiProperty({ enum: PlanFrequency })
	@Prop({ enum: PlanFrequency, default: PlanFrequency.MONTHLY })
	frequency: PlanFrequency;

	@ApiProperty()
	@Prop({ default: false })
	autopay: boolean;

	@ApiProperty()
	@Prop({ default: true })
	notifyEveryPayment: boolean;

	@ApiProperty({ minimum: 0, maximum: 14 })
	@Prop({ default: 3, min: 0, max: 14 })
	remindDaysBefore: number;

	/** Card saved at Checkout for autopay (off-session). Never sent to clients. */
	@Prop({ type: String, select: false })
	paymentMethodId?: string;
}

export const RentPlanSchema = SchemaFactory.createForClass(RentPlan);

RentPlanSchema.index({ tenancy: 1, tenant: 1 }, { unique: true });
