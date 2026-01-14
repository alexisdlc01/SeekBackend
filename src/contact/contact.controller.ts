import { Body, Controller, Post } from "@nestjs/common";
import { ContactDto } from "./dto/contact.dto";
import { ContactService } from "./contact.service";
import { ApiTags } from "@nestjs/swagger";
import { ApiContactDocs } from "./contact-swagger.decorator";

@ApiTags("Contact")
@Controller("contact")
export class ContactController {
	constructor(private readonly contactService: ContactService) {}

	@ApiContactDocs()
	@Post()
	async contact(@Body() body: ContactDto) {
		await this.contactService.contact(body);
	}
}
