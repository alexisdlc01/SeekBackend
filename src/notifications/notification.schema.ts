import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { ApiProperty } from "@nestjs/swagger";
import { SchemaTypes, Types } from "mongoose";
import { NotificationKind } from "./notification-kind.enum";
import { NotificationScreen, NotificationTarget, NotificationTargetKind } from "./links";

@Schema({ timestamps: true })
export class Notification {
	@ApiProperty({ type: String })
	@Prop({ type: SchemaTypes.ObjectId, auto: true })
	_id: Types.ObjectId;

	@ApiProperty({ type: String })
	@Prop({ type: SchemaTypes.ObjectId, ref: "User", required: true })
	user: Types.ObjectId;

	@ApiProperty({ enum: NotificationKind })
	@Prop({ enum: NotificationKind, required: true })
	kind: NotificationKind;

	@ApiProperty()
	@Prop({ required: true, trim: true })
	title: string;

	@ApiProperty({ required: false })
	@Prop({ trim: true })
	body?: string;

	@ApiProperty({ required: false, description: "seek-web path to open, e.g. /student/home/rent. Same route as `target`." })
	@Prop()
	link?: string;

	@ApiProperty({
		required: false,
		description: [
			"Typed destination: a logical `screen` plus the `id` it is about. Clients route on `screen`;",
			"`link` is the seek-web path and `mobile` the seek-mobile path (students only).",
			"",
			"| kind | student screen → web / mobile | landlord screen → web |",
			"|---|---|---|",
			"| PAYMENTS | rent → /student/home/rent / /(app)/(tabs)/rent | landlord-rent → /rent |",
			"| COMPLIANCE | deposit → /student/home/deposit / /(app)/deposit | dashboard → /dashboard |",
			"| TENANCY | home → /student/home / /(app)/(tabs)/my-home | contracts → /contracts |",
			"| CONTRACTS | contract → /student/home / /(app)/contract | contracts → /contracts |",
			"| REPAIRS | repairs → /student/home / /(app)/repairs | dashboard → /dashboard |",
			"| APPLICATION | applications → /student/home / /(app)/(tabs)/applied | application → /application?listing=<listing>&id=<id> (or /applicants) |"
		].join("\n"),
		example: { kind: "PAYMENTS", screen: "rent", mobile: "/(app)/(tabs)/rent" }
	})
	@Prop({
		type: {
			kind: { type: String, enum: Object.values(NotificationTargetKind) },
			screen: { type: String, enum: Object.values(NotificationScreen) },
			id: String,
			listing: String,
			mobile: String
		},
		_id: false
	})
	target?: NotificationTarget;

	@ApiProperty({ type: String, format: "date-time", nullable: true })
	@Prop({ type: Date, default: null })
	readAt: Date | null;

	/** Stops scheduled jobs from sending the same reminder twice. */
	@Prop({ type: String })
	dedupeKey?: string;

	@ApiProperty({ type: String, format: "date-time" })
	createdAt?: Date;
}

export const NotificationSchema = SchemaFactory.createForClass(Notification);

NotificationSchema.index({ user: 1, createdAt: -1 });
NotificationSchema.index(
	{ user: 1, dedupeKey: 1 },
	{ unique: true, partialFilterExpression: { dedupeKey: { $type: "string" } } }
);
