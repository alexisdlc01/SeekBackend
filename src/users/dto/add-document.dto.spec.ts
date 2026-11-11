import { BadRequestException, ValidationPipe } from "@nestjs/common";
import { AddDocumentDto } from "./add-document.dto";
import { DocumentType } from "../types/document-type";

// Landlords open this url from the passport: only https links are stored.
describe("AddDocumentDto", () => {
	const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
	const run = (url: string) =>
		pipe.transform({ documentType: DocumentType.PASSPORT, url, key: "private/u/1.pdf" }, { type: "body", metatype: AddDocumentDto });

	it.each(["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "http://example.com/a.pdf"])("rejects %s", async url => {
		await expect(run(url)).rejects.toThrow(BadRequestException);
	});

	it("accepts an https link", async () => {
		await expect(run("https://bucket.s3.eu-west-2.amazonaws.com/a.pdf")).resolves.toBeDefined();
	});
});
