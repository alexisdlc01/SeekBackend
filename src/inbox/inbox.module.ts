import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { SharedModule } from "../shared/shared.module";
import { ConversationModule } from "../conversation/conversation.module";
import { Conversation, ConversationSchema } from "../conversation/converstaion.schema";
import { Message, MessageSchema } from "../conversation/message.schema";
import { ConnectorsModule } from "../connectors/connectors.module";
import { TenanciesModule } from "../tenancies/tenancies.module";
import { InboxController } from "./inbox.controller";
import { InboxService } from "./inbox.service";

@Module({
	imports: [
		MongooseModule.forFeature([
			{ name: Conversation.name, schema: ConversationSchema },
			{ name: Message.name, schema: MessageSchema }
		]),
		SharedModule,
		ConversationModule,
		ConnectorsModule,
		TenanciesModule
	],
	controllers: [InboxController],
	providers: [InboxService]
})
export class InboxModule {}
