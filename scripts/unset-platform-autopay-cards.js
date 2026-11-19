/**
 * One-off, run once when direct charges ship: autopay cards saved before then live on
 * Seek's platform account, which can no longer charge rent. Unsetting them makes tenants
 * save a card again at their next Checkout (on the landlord's account).
 *
 *   MONGODB_URI=... node scripts/unset-platform-autopay-cards.js
 */
const mongoose = require("mongoose");

async function main() {
	const uri = process.env.MONGODB_URI;
	if (!uri) throw new Error("Set MONGODB_URI.");
	await mongoose.connect(uri);
	const result = await mongoose.connection.collection("rentplans").updateMany(
		// Plans without a customer on the landlord's account hold a platform card; safe to re-run after deploy.
		{ paymentMethodId: { $exists: true }, stripeCustomerId: { $exists: false } },
		{ $unset: { paymentMethodId: 1 } }
	);
	console.log(`Autopay cards unset on ${result.modifiedCount} rent plans.`);
	await mongoose.disconnect();
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});
