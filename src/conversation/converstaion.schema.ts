import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import { Message } from "./message.schema";

@Schema({
	toJSON: { virtuals: true },
	toObject: { virtuals: true },
})
export class Conversation {
	@Prop({ type: SchemaTypes.ObjectId, auto: true })
	_id: Types.ObjectId;

	@Prop({ required: true, trim: true })
	name: string;

	@Prop({ default: Date.now, index: true })
	createdAt: Date;

	@Prop({ default: "" })
	groupDescription: string;

	@Prop()
	avatar?: string;

	@Prop({ type: SchemaTypes.ObjectId, ref: "User" })
	createdBy: Types.ObjectId;

	@Prop({ type: [SchemaTypes.ObjectId], ref: "User", default: [] })
	users: Types.ObjectId[];

	@Prop({ type: SchemaTypes.ObjectId, ref: "Message" })
	lastMessage?: Types.ObjectId;

	messages: Message[]
}

export const ConversationSchema = SchemaFactory.createForClass(Conversation);

ConversationSchema.index({ users: 1 });
ConversationSchema.index({ createdAt: -1 });

ConversationSchema.virtual("messages", {
	ref: "Message",
	localField: "_id",
	foreignField: "conversation",
});

ConversationSchema.pre(
	"deleteOne",
	{ document: true, query: false },
	async function(next) {
		try {
			await this.model("Message").deleteMany({ conversation: this._id });
			next();
		} catch (e) {
			next(e as any);
		}
	}
);
