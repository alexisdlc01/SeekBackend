import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { SharedModule } from "../shared/shared.module";
import { Message, MessageSchema } from "./message.schema";

@Module({
	imports: [
		MongooseModule.forFeature([
			{
				name: Message.name,
				schema: MessageSchema
			}
		]),
		SharedModule
	]
})
export class MessageModule {}
