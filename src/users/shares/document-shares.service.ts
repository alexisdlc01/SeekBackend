import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { DocumentShare, SHARE_TTL_MS } from "./document-share.schema";

export interface ShareView {
	_id: string;
	viewer: { _id: string; name?: string; companyName?: string } | string;
	listing: { _id: string; propertyTitle?: string; streetAddress?: string } | string | null;
	application: string | null;
	expiresAt: Date;
	revokedAt: Date | null;
	active: boolean;
	createdAt?: Date;
}

export function isShareActive(
	share: Pick<DocumentShare, "expiresAt" | "revokedAt">,
	now: Date = new Date()
): boolean {
	return !share.revokedAt && new Date(share.expiresAt).getTime() > now.getTime();
}

@Injectable()
export class DocumentSharesService {
	constructor(
		@InjectModel(DocumentShare.name)
		private readonly shareModel: Model<DocumentShare>
	) {}

	/**
	 * Grants the landlord a fresh 14-day window on each applicant's files.
	 * Re-sending refreshes the window but never resurrects a share the
	 * student revoked.
	 */
	async shareForApplication(params: {
		ownerIds: (Types.ObjectId | string)[];
		viewer: Types.ObjectId | string;
		listing?: Types.ObjectId | string;
		application: Types.ObjectId | string;
		now?: Date;
	}): Promise<void> {
		const now = params.now ?? new Date();
		const expiresAt = new Date(now.getTime() + SHARE_TTL_MS);
		if (params.ownerIds.length === 0) return;
		await this.shareModel.bulkWrite(
			params.ownerIds.map(owner => ({
				updateOne: {
					filter: {
						owner: new Types.ObjectId(owner.toString()),
						application: new Types.ObjectId(params.application.toString())
					},
					update: {
						$set: {
							viewer: new Types.ObjectId(params.viewer.toString()),
							...(params.listing
								? { listing: new Types.ObjectId(params.listing.toString()) }
								: {}),
							expiresAt
						},
						$setOnInsert: { revokedAt: null }
					},
					upsert: true
				}
			}))
		);
	}

	async listForOwner(ownerId: string, now: Date = new Date()): Promise<ShareView[]> {
		const shares = await this.shareModel
			.find({ owner: new Types.ObjectId(ownerId) })
			.populate({ path: "viewer", select: "name companyName" })
			.populate({ path: "listing", select: "propertyTitle streetAddress cityTown" })
			.sort({ expiresAt: -1 })
			.lean()
			.exec();
		return shares.map(share => ({
			_id: share._id.toString(),
			viewer: share.viewer as unknown as ShareView["viewer"],
			listing: (share.listing ?? null) as unknown as ShareView["listing"],
			application: share.application?.toString() ?? null,
			expiresAt: share.expiresAt,
			revokedAt: share.revokedAt ?? null,
			active: isShareActive(share, now),
			createdAt: share.createdAt
		}));
	}

	async revoke(ownerId: string, shareId: string): Promise<void> {
		if (!Types.ObjectId.isValid(shareId)) {
			throw new NotFoundException("Share not found");
		}
		const result = await this.shareModel.updateOne(
			{
				_id: new Types.ObjectId(shareId),
				owner: new Types.ObjectId(ownerId)
			},
			{ $set: { revokedAt: new Date() } }
		);
		if (result.matchedCount === 0) {
			throw new NotFoundException("Share not found");
		}
	}

	/** Owners whose documents this viewer may open right now, with the share's end. */
	async activeOwnersFor(
		viewerId: string,
		ownerIds: (Types.ObjectId | string)[],
		now: Date = new Date()
	): Promise<Map<string, Date>> {
		if (ownerIds.length === 0) return new Map();
		const shares = await this.shareModel
			.find({
				viewer: new Types.ObjectId(viewerId),
				owner: { $in: ownerIds.map(id => new Types.ObjectId(id.toString())) },
				revokedAt: null,
				expiresAt: { $gt: now }
			})
			.select("owner expiresAt")
			.lean()
			.exec();
		const result = new Map<string, Date>();
		for (const share of shares) {
			const owner = share.owner.toString();
			const current = result.get(owner);
			if (!current || current < share.expiresAt) {
				result.set(owner, share.expiresAt);
			}
		}
		return result;
	}
}
