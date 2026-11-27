import { Logger } from "@nestjs/common";
import { Model, Types } from "mongoose";
import { Payment } from "./payment.schema";
import { PaymentKind, PaymentProvider, PaymentStatus, PayoutStatus } from "./payment.enums";
import { StripeApiError, StripeClient } from "./stripe";
import { NotificationsService } from "../notifications/notifications.service";
import { NotificationKind } from "../notifications/notification-kind.enum";
import { notificationTarget, NotificationTargetKind } from "../notifications/links";

const logger = new Logger("PaymentRefund");

export type RefundablePayment = Pick<Payment, "_id" | "amount" | "provider" | "providerRef" | "status" | "refundedAt" | "refundedAmount"> &
	Partial<Pick<Payment, "refundRef" | "refundFailed" | "payoutStatus" | "payoutReleaseStartedAt" | "transferRef" | "reversalRef" | "seekFee" | "stripeAccountId">> & {
	_id: Types.ObjectId;
};

// product decision pending (Alexis): proportional Seek fee on refunds
export function proportionalRefund(amount: number, refunded: number, seekFee: number) {
	const tenantRefund = Math.max(0, Math.min(amount, refunded));
	const kept = amount - tenantRefund;
	const keptSeekFee = amount > 0 ? Math.round(seekFee * kept / amount) : 0;
	const refundedSeekFee = seekFee - keptSeekFee;
	return {
		tenantRefund,
		landlordNet: kept - keptSeekFee,
		keptSeekFee,
		transferReversal: tenantRefund - refundedSeekFee
	};
}

/** Existing Stripe refund path, shared by duplicate, holding-deposit and early-end refunds. */
export async function refundStripeCharge(params: {
	secretKey: string;
	intentId: string;
	reason: "duplicate" | "requested_by_customer";
	amount?: number;
	idempotencyKey?: string;
	/** Connected account of a direct charge; omitted for legacy platform charges. */
	account?: string;
}): Promise<{ id: string; status: string } | null> {
	try {
		const stripe = new StripeClient(params.secretKey, params.account);
		const intent = await stripe.retrievePaymentIntent(params.intentId);
		return await stripe.createRefund(
			{
				payment_intent: params.intentId,
				reason: params.reason,
				...(params.amount !== undefined ? { amount: params.amount } : {}),
				// Legacy destination charge: take it back from the landlord. A direct charge is refunded from their own balance.
				...(intent.transfer_data ? { reverse_transfer: true } : {}),
				// Seek's application fee goes back pro rata, so the landlord isn't charged a fee on refunded rent.
				...(intent.application_fee_amount ? { refund_application_fee: true } : {})
			},
			params.idempotencyKey ?? `seek-refund-${params.intentId}`
		);
	} catch (error) {
		if (!(error instanceof StripeApiError)) throw error;
		logger.error(`Refund of charge ${params.intentId} failed (${error.status}): ${error.message}. Refund it in the Stripe dashboard.`);
		return null;
	}
}

/** Refunds one recorded payment once. An unsettled Stripe refund stays due; a terminal failure does not. */
export async function refundPayment(
	paymentModel: Model<Payment>,
	payment: RefundablePayment,
	secretKey: string | undefined,
	amount: number = payment.amount
): Promise<boolean> {
	if (amount <= 0 || payment.refundedAt) return true;
	if (payment.refundFailed || payment.payoutReleaseStartedAt) return false;
	if (payment.status !== PaymentStatus.PAID) return false;

	let refundRef: string | null = payment.refundRef ?? null;
	let refundStatus = "succeeded";
	if (payment.provider === PaymentProvider.SIMULATED || payment.providerRef?.startsWith("sim_")) {
		refundRef = `sim_refund_${payment._id.toString()}`;
	} else {
		if (payment.provider !== PaymentProvider.STRIPE || !payment.providerRef?.startsWith("pi_") || !secretKey) {
			logger.error(`Payment ${payment._id.toString()} cannot be refunded automatically (${payment.providerRef ?? "no provider reference"}). Refund it in the Stripe dashboard.`);
			return false;
		}
		const stripe = new StripeClient(secretKey, payment.stripeAccountId ?? undefined);
		const refunded = refundRef?.startsWith("re_")
			? await stripe.retrieveRefund(refundRef).catch(error => {
				if (!(error instanceof StripeApiError)) throw error;
				logger.error(`Refund ${refundRef} for payment ${payment._id.toString()} could not be checked (${error.status}): ${error.message}.`);
				return null;
			})
			: await refundStripeCharge({
				secretKey,
				intentId: payment.providerRef,
				reason: "requested_by_customer",
				account: payment.stripeAccountId ?? undefined,
				...(amount < payment.amount ? { amount } : {}),
				idempotencyKey: `seek-payment-refund-${payment._id.toString()}`
			});
		if (!refunded) return false;
		refundRef = refunded.id;
		refundStatus = refunded.status;
		await paymentModel.updateOne(
			{ _id: payment._id, refundedAt: null },
			{ $set: { refundRef, refundAmount: amount } }
		);
		if (["failed", "canceled"].includes(refundStatus)) {
			const failed = await paymentModel.updateOne(
				{ _id: payment._id, refundFailed: { $ne: true } },
				{ $set: { refundFailed: true, refundDue: false } }
			);
			if (failed.modifiedCount > 0) {
				logger.error(`Refund ${refundRef} for payment ${payment._id.toString()} ended ${refundStatus}; automatic retries stopped.`);
			}
			return false;
		}
		if (refundStatus !== "succeeded") {
			return true;
		}
		if (payment.payoutStatus === PayoutStatus.TRANSFERRED && payment.transferRef && !payment.reversalRef) {
			const reversalAmount = proportionalRefund(payment.amount, amount, payment.seekFee ?? 0).transferReversal;
			if (reversalAmount > 0) {
				try {
					// Transfers are Seek's own (platform) objects.
					const reversal = await new StripeClient(secretKey).createTransferReversal(
						payment.transferRef,
						{ amount: reversalAmount },
						`seek-payment-refund-reversal-${payment._id.toString()}`
					);
					await paymentModel.updateOne(
						{ _id: payment._id },
						{ $set: { reversalRef: reversal.id } }
					);
				} catch (error) {
					if (!(error instanceof StripeApiError)) throw error;
					logger.error(`Transfer ${payment.transferRef} for refunded payment ${payment._id.toString()} could not be reversed (${error.status}): ${error.message}.`);
					return false;
				}
			}
		}
	}

	await paymentModel.updateOne(
		{ _id: payment._id, refundedAt: null },
		{
			$set: {
				refundDue: false,
				refundAmount: amount,
				refundedAmount: amount,
				refundedAt: new Date(),
				refundRef
			}
		}
	);
	return true;
}

/**
 * Tells the tenant who paid a holding deposit that its refund started, or that it stopped for good
 * (the landlord is asked to refund by hand then). Each once per payment; a refund still due says nothing yet.
 */
export async function notifyHoldingRefund(
	notifications: NotificationsService,
	paymentModel: Model<Payment>,
	payment: Pick<Payment, "kind" | "tenant" | "landlord" | "amount"> & Partial<Pick<Payment, "refundAmount">> & { _id: Types.ObjectId },
	accepted: boolean
) {
	if (payment.kind !== PaymentKind.HOLDING_DEPOSIT) return;
	const failed = !accepted && (await paymentModel.exists({ _id: payment._id, refundFailed: true })) !== null;
	if (!accepted && !failed) return;
	// A partial refund (early tenancy end surplus) names what is actually refunded.
	const amount = `£${((payment.refundAmount || payment.amount) / 100).toFixed(2)}`;
	const key = `holding-refund-${failed ? "failed" : "started"}:${payment._id.toString()}`;
	await notifications.notify({
		user: payment.tenant,
		kind: NotificationKind.HOLDING_DEPOSIT_REFUND,
		title: failed ? `Your ${amount} holding deposit couldn't be refunded automatically` : `Your ${amount} holding deposit is being refunded`,
		body: failed
			? "Stripe couldn't complete the refund. Your landlord has been asked to refund you directly."
			: "Seek has started the refund to the card you paid with.",
		...notificationTarget("student", NotificationTargetKind.PAYMENTS),
		dedupeKey: key
	});
	if (failed) await notifications.notify({
		user: payment.landlord,
		kind: NotificationKind.HOLDING_DEPOSIT_REFUND,
		title: `Refund a ${amount} holding deposit yourself`,
		body: "Seek's automatic refund failed. Refund it from your Stripe dashboard or another way.",
		...notificationTarget("landlord", NotificationTargetKind.PAYMENTS),
		dedupeKey: key
	});
}

/**
 * Closes a payment's open Checkout session or PaymentIntent on the account it was opened on,
 * before its row is deleted, so the tenant can't pay something Seek no longer records.
 */
export async function closeStripeCharge(secretKey: string | undefined, payment: Pick<Payment, "providerRef" | "stripeAccountId"> & { _id: Types.ObjectId }) {
	const ref = payment.providerRef;
	if (!secretKey || !ref || !/^(cs|pi)_/.test(ref)) return;
	try {
		const stripe = new StripeClient(secretKey, payment.stripeAccountId ?? undefined);
		if (ref.startsWith("cs_")) await stripe.expireCheckoutSession(ref);
		else await stripe.cancelPaymentIntent(ref);
	} catch (error) {
		// Already expired, completed or cancelled: a charge that went through anyway is refunded when its webhook finds no row.
		logger.warn(`Could not close ${ref} for payment ${payment._id.toString()}: ${(error as Error).message}`);
	}
}
