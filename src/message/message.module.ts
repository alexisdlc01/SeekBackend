import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { SharedModule } from "../shared/shared.module";
import { Message, MessageSchema } from "../conversation/message.schema";
import { MessageController } from './message.controller';

@Module({
	imports: [
		SharedModule
	],
	controllers: [MessageController]
})
export class MessageModule {}
