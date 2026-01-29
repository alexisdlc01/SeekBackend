import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { ApiProperty } from "@nestjs/swagger";
import { SchemaTypes, Types } from "mongoose";

@Schema()
export class Conversation {
	@ApiProperty()
	@Prop({ type: SchemaTypes.ObjectId, auto: true })
	_id: Types.ObjectId;

	@ApiProperty()
	@Prop({ required: true, trim: true })
	name: string;

	@ApiProperty()
	@Prop({ default: Date.now, index: true })
	createdAt: Date;

	@ApiProperty()
	@Prop()
	groupDescription?: string;

	@ApiProperty()
	@Prop()
	avatar?: string;

	@ApiProperty()
	@Prop({ type: SchemaTypes.ObjectId, ref: "User" })
	createdBy: Types.ObjectId;

	@ApiProperty({ isArray: true, type: String })
	@Prop({ type: [SchemaTypes.ObjectId], ref: "User", default: [] })
	users: Types.ObjectId[];

	@ApiProperty()
	@Prop({ type: SchemaTypes.ObjectId, ref: "Message" })
	lastMessage?: Types.ObjectId;
}

export const ConversationSchema = SchemaFactory.createForClass(Conversation);

ConversationSchema.index({ users: 1 });
ConversationSchema.index({ createdAt: -1 });

ConversationSchema.virtual("messages", {
	ref: "Message",
	localField: "_id",
	foreignField: "conversation",
	justOne: false
});

// ConversationSchema.virtual("lastMessage", {
// 	ref: "Message",
// 	localField: "_id",
// 	foreignField: "conversation",
// 	justOne: true,
// 	options: { sort: { createdAt: -1 } }
// });

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
