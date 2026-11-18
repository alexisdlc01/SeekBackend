import { Logger } from "@nestjs/common";
import { Model, Types } from "mongoose";
import { Payment } from "./payment.schema";
import { PaymentProvider, PaymentStatus, PayoutStatus } from "./payment.enums";
import { StripeApiError, StripeClient } from "./stripe";

const logger = new Logger("PaymentRefund");

export type RefundablePayment = Pick<Payment, "_id" | "amount" | "provider" | "providerRef" | "status" | "refundedAt" | "refundedAmount"> &
	Partial<Pick<Payment, "refundRef" | "refundFailed" | "payoutStatus" | "payoutReleaseStartedAt" | "transferRef" | "reversalRef" | "seekFee">> & {
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
}): Promise<{ id: string; status: string } | null> {
	try {
		const stripe = new StripeClient(params.secretKey);
		const intent = await stripe.retrievePaymentIntent(params.intentId);
		return await stripe.createRefund(
			{
				payment_intent: params.intentId,
				reason: params.reason,
				...(params.amount !== undefined ? { amount: params.amount } : {}),
				// A destination charge already went to the landlord: take it back from them, with Seek's fee.
				...(intent.transfer_data ? { reverse_transfer: true } : {}),
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
		const stripe = new StripeClient(secretKey);
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
					const reversal = await stripe.createTransferReversal(
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
