import { Controller } from "@nestjs/common";
import { DummyMessageDocs } from "./message-swagger.decorator";

@Controller("message")
export class MessageController {
	@DummyMessageDocs()
	async dummy() {}
}
