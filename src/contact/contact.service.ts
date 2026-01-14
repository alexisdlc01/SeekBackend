import { Injectable } from "@nestjs/common";
import { MailService } from "../auth/mail.service";
import { ContactDto } from "./dto/contact.dto";

@Injectable()
export class ContactService {
	constructor(private readonly mailService: MailService) {}

	async contact({ email, message, name }: ContactDto) {
		await this.mailService.sendContactEmail(name, email, message);
	}
}
