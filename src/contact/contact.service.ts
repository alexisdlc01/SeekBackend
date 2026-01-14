import { Injectable } from "@nestjs/common";
import { MailService } from "../auth/mail.service";
import { ContactDto } from "./dto/contact.dto";
import { ApiContactDocs } from "./contact-swagger.decorator";

@Injectable()
export class ContactService {
	constructor(private readonly mailService: MailService) {}

	@ApiContactDocs()
	async contact({ email, message, name }: ContactDto) {
		await this.mailService.sendContactEmail(name, email, message);
	}
}
