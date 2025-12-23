import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { SharedModule } from "../shared/shared.module";
import { Message, MessageSchema } from "./message.schema";
import { MessageController } from './message.controller';

@Module({
	imports: [
		MongooseModule.forFeature([
			{
				name: Message.name,
				schema: MessageSchema
			}
		]),
		SharedModule
	],
	controllers: [MessageController]
})
export class MessageModule {}
