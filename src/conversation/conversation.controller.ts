import { Controller } from "@nestjs/common";
import { DummyConversationDocs } from "./message-swagger.decorator";

@Controller("conversation")
export class ConversationController {
	@DummyConversationDocs()
	async dummmy() {}
}
