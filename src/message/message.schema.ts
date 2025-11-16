import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";

export enum MessageType {
	Text = "Text",
	Image = "Image"
}

@Schema()
export class Message {
	@Prop({ type: SchemaTypes.ObjectId, auto: true })
	_id: Types.ObjectId;

	@Prop({ type: SchemaTypes.ObjectId, ref: "User" })
	sender: Types.ObjectId;

	@Prop({ enum: MessageType, default: MessageType.Text })
	messageType: MessageType;

	@Prop({ required: true, trim: true })
	data: string;

	@Prop({ default: Date.now, index: true })
	createdAt: Date;

	@Prop({ type: SchemaTypes.ObjectId, ref: "Conversation", required: true })
	conversation: Types.ObjectId;

	@Prop({ type: [SchemaTypes.ObjectId], ref: "User", default: [] })
	seenUsers: Types.ObjectId[];

	@Prop({ type: [SchemaTypes.ObjectId], ref: "User", default: [] })
	deliveredTo: Types.ObjectId[];
}

export const MessageSchema = SchemaFactory.createForClass(Message);

MessageSchema.index({ conversation: 1, createdAt: -1 });
MessageSchema.index({ sender: 1, createdAt: -1 });

MessageSchema.virtual("conversationDoc", {
	ref: "Conversation",
	localField: "conversation",
	foreignField: "_id",
	justOne: true
});

MessageSchema.virtual("senderDoc", {
	ref: "User",
	localField: "sender",
	foreignField: "_id",
	justOne: true
});
