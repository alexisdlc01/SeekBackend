import { DocumentReviewService } from "./document-review.service";
import { DocumentStatus } from "./types/document-type";

describe("DocumentReviewService.sweep", () => {
	it("moves every PENDING document, whatever its type, to PROVIDED", async () => {
		const userModel = { updateMany: jest.fn().mockResolvedValue({}) };
		const service = new DocumentReviewService(userModel as never, { get: () => "test" } as never);
		await service.sweep();
		expect(userModel.updateMany).toHaveBeenCalledWith(
			{ documents: { $elemMatch: { status: DocumentStatus.PENDING } } },
			{ $set: { "documents.$[doc].status": DocumentStatus.PROVIDED } },
			{ arrayFilters: [{ "doc.status": DocumentStatus.PENDING }] }
		);
	});
});
