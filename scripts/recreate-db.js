const fs = require("node:fs");
const path = require("node:path");
const mongoose = require("mongoose");
const { hash } = require("bcryptjs");

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function loadEnv() {
	const envPath = path.join(__dirname, "..", ".env");
	if (!fs.existsSync(envPath)) {
		return;
	}

	const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) {
			continue;
		}

		const separator = trimmed.indexOf("=");
		if (separator === -1) {
			continue;
		}

		const key = trimmed.slice(0, separator).trim();
		let value = trimmed.slice(separator + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		process.env[key] ??= value;
	}
}

const oid = value => new mongoose.Types.ObjectId(value);
const daysFromNow = days => new Date(Date.now() + days * ONE_DAY_MS);
const daysAgo = days => new Date(Date.now() - days * ONE_DAY_MS);

const ids = {
	admin: oid("665000000000000000000001"),
	student: oid("665000000000000000000002"),
	studentTwo: oid("665000000000000000000003"),
	landlord: oid("665000000000000000000004"),
	agency: oid("665000000000000000000005"),
	listingOne: oid("665000000000000000000101"),
	listingTwo: oid("665000000000000000000102"),
	listingThree: oid("665000000000000000000103"),
	listingFour: oid("665000000000000000000104"),
	listingUnverified: oid("665000000000000000000105"),
	listingDraft: oid("665000000000000000000106"),
	conversation: oid("665000000000000000000201"),
	messageOne: oid("665000000000000000000301"),
	messageTwo: oid("665000000000000000000302"),
	application: oid("665000000000000000000401"),
	flag: oid("665000000000000000000501")
};

const COLLECTIONS = [
	"users",
	"listings",
	"conversations",
	"messages",
	"applications",
	"flags"
];

async function createIndexes(db) {
	await Promise.all([
		db.collection("users").createIndex({ email: 1 }, { unique: true }),
		db.collection("listings").createIndex({ landlord: 1 }),
		db.collection("listings").createIndex({ location: "2dsphere" }),
		db.collection("listings").createIndex(
			{ createdAt: 1 },
			{
				expireAfterSeconds: 60 * 60 * 24 * 7,
				partialFilterExpression: { isDraft: true }
			}
		),
		db.collection("applications").createIndex({ applicants: 1 }),
		db.collection("conversations").createIndex({ users: 1 }),
		db.collection("conversations").createIndex({ createdAt: -1 }),
		db.collection("messages").createIndex({ conversation: 1, createdAt: -1 }),
		db.collection("messages").createIndex({ sender: 1, createdAt: -1 })
	]);
}

function listing({
	_id,
	landlord,
	propertyTitle,
	numOfPeople,
	sizeSqMeters,
	propertyType,
	bedroomsCount,
	enSuiteBedroomCount = 0,
	bathrooms,
	propertyDesc,
	amenities,
	streetAddress,
	cityTown,
	postcodeZIP,
	country,
	monthlyRent,
	securityDeposit,
	availableFrom,
	availableUntil,
	furnishingStatus,
	epcRating,
	photos,
	isVerified = true,
	isDraft = false,
	formattedAddress,
	coordinates
}) {
	const now = new Date();
	return {
		_id,
		landlord,
		propertyTitle,
		numOfPeople,
		sizeSqMeters,
		propertyType,
		bedroomsCount,
		enSuiteBedroomCount,
		bathrooms,
		propertyDesc,
		amenities,
		streetAddress,
		cityTown,
		postcodeZIP,
		country,
		monthlyRent,
		securityDeposit,
		availableFrom,
		availableUntil,
		furnishingStatus,
		epcRating,
		photos,
		videoTourLink: "",
		floorPlanImage: "",
		requirements: [
			{
				name: "Photo identification",
				desc: "Passport, national ID, or driving licence.",
				required: true
			},
			{
				name: "Proof of student status",
				desc: "University enrolment letter or student card.",
				required: true
			}
		],
		isVerified,
		isDraft,
		lastUpdated: now,
		likedBy: [ids.student],
		formatted_address: formattedAddress,
		location: {
			type: "Point",
			coordinates
		},
		createdAt: now,
		updatedAt: now
	};
}

async function seed(db) {
	const password = await hash("Password123!", 10);
	const now = new Date();

	const users = [
		{
			_id: ids.admin,
			name: "Seek Admin",
			email: "admin@seek.local",
			password,
			role: "SUPERUSER",
			isVerified: true,
			isGoogle: false,
			documents: [],
			profilePicUrl: "https://i.pravatar.cc/200?img=12",
			lastSeen: now,
			createdAt: now,
			updatedAt: now
		},
		{
			_id: ids.student,
			name: "Maya Student",
			email: "student@seek.local",
			password,
			role: "STUDENT",
			isVerified: true,
			isGoogle: false,
			documents: [
				{
					type: "IDENTIFICATION",
					url: "https://example.com/local/identity.pdf",
					key: "seed/identity.pdf"
				}
			],
			profilePicUrl: "https://i.pravatar.cc/200?img=32",
			lastSeen: now,
			createdAt: now,
			updatedAt: now
		},
		{
			_id: ids.studentTwo,
			name: "Leo Applicant",
			email: "applicant@seek.local",
			password,
			role: "STUDENT",
			isVerified: true,
			isGoogle: false,
			documents: [],
			profilePicUrl: "https://i.pravatar.cc/200?img=45",
			lastSeen: daysAgo(1),
			createdAt: now,
			updatedAt: now
		},
		{
			_id: ids.landlord,
			name: "Avery Landlord",
			email: "landlord@st-andrews.ac.uk",
			password,
			role: "LANDLORD_AGENCY",
			isVerified: true,
			isGoogle: false,
			documents: [],
			profilePicUrl: "https://i.pravatar.cc/200?img=5",
			lastSeen: daysAgo(2),
			createdAt: now,
			updatedAt: now
		},
		{
			_id: ids.agency,
			name: "Northbridge Lettings",
			email: "agency@seek.local",
			password,
			role: "LANDLORD_AGENCY",
			isVerified: true,
			isGoogle: false,
			documents: [],
			profilePicUrl: "https://i.pravatar.cc/200?img=15",
			lastSeen: daysAgo(3),
			createdAt: now,
			updatedAt: now
		}
	];

	const listings = [
		listing({
			_id: ids.listingOne,
			landlord: ids.landlord,
			propertyTitle: "Bright Marchmont flat near the Meadows",
			numOfPeople: 3,
			sizeSqMeters: 72,
			propertyType: "FLAT_APARTMENT",
			bedroomsCount: 3,
			bathrooms: 1,
			propertyDesc:
				"Three bedroom student flat with a large living room, study desks, and fast access to the University of Edinburgh.",
			amenities: ["WiFi", "Washing_Machine", "Dishwasher", "Bike Storage"],
			streetAddress: "25 Marchmont Road",
			cityTown: "Edinburgh",
			postcodeZIP: "EH9 1HY",
			country: "United Kingdom",
			monthlyRent: 2250,
			securityDeposit: 2250,
			availableFrom: daysFromNow(14),
			availableUntil: daysFromNow(380),
			furnishingStatus: "Furnished",
			epcRating: "C",
			photos: [
				"https://images.unsplash.com/photo-1522708323590-d24dbb6b0267",
				"https://images.unsplash.com/photo-1505693416388-ac5ce068fe85"
			],
			formattedAddress: "25 Marchmont Road, Edinburgh EH9 1HY, UK",
			coordinates: [-3.1907, 55.9386]
		}),
		listing({
			_id: ids.listingTwo,
			landlord: ids.agency,
			propertyTitle: "Studio beside Glasgow University",
			numOfPeople: 1,
			sizeSqMeters: 34,
			propertyType: "STUDIO",
			bedroomsCount: 1,
			bathrooms: 1,
			propertyDesc:
				"Compact furnished studio close to Kelvingrove Park, transport, and west end cafes.",
			amenities: ["WiFi", "Washing_Machine", "Smoke_Alarm"],
			streetAddress: "9 Gibson Street",
			cityTown: "Glasgow",
			postcodeZIP: "G12 8NU",
			country: "United Kingdom",
			monthlyRent: 980,
			securityDeposit: 980,
			availableFrom: daysFromNow(21),
			availableUntil: daysFromNow(365),
			furnishingStatus: "Furnished",
			epcRating: "B",
			photos: [
				"https://images.unsplash.com/photo-1493809842364-78817add7ffb",
				"https://images.unsplash.com/photo-1560448204-e02f11c3d0e2"
			],
			formattedAddress: "9 Gibson Street, Glasgow G12 8NU, UK",
			coordinates: [-4.2869, 55.8721]
		}),
		listing({
			_id: ids.listingThree,
			landlord: ids.landlord,
			propertyTitle: "Shared house room in Fallowfield",
			numOfPeople: 1,
			sizeSqMeters: 18,
			propertyType: "ROOM_IN_SHARED_HOUSE",
			bedroomsCount: 1,
			bathrooms: 2,
			propertyDesc:
				"Room in a five person shared house with garden, bike storage, and bills package available.",
			amenities: ["WiFi", "Garden", "Bike Storage", "Parking"],
			streetAddress: "42 Wilmslow Road",
			cityTown: "Manchester",
			postcodeZIP: "M14 5TQ",
			country: "United Kingdom",
			monthlyRent: 650,
			securityDeposit: 650,
			availableFrom: daysFromNow(30),
			availableUntil: daysFromNow(395),
			furnishingStatus: "Part-Furnished",
			epcRating: "D",
			photos: [
				"https://images.unsplash.com/photo-1484154218962-a197022b5858",
				"https://images.unsplash.com/photo-1519710164239-da123dc03ef4"
			],
			formattedAddress: "42 Wilmslow Road, Manchester M14 5TQ, UK",
			coordinates: [-2.2247, 53.4434]
		}),
		listing({
			_id: ids.listingFour,
			landlord: ids.agency,
			propertyTitle: "Two bedroom apartment near UCL",
			numOfPeople: 2,
			sizeSqMeters: 58,
			propertyType: "FLAT_APARTMENT",
			bedroomsCount: 2,
			bathrooms: 1,
			propertyDesc:
				"Central two bedroom flat suitable for postgraduate sharers, with secure entry and good transport links.",
			amenities: ["WiFi", "Dishwasher", "Dryer", "Smoke_Alarm"],
			streetAddress: "12 Gower Street",
			cityTown: "London",
			postcodeZIP: "WC1E 6BT",
			country: "United Kingdom",
			monthlyRent: 3100,
			securityDeposit: 3100,
			availableFrom: daysFromNow(18),
			availableUntil: daysFromNow(370),
			furnishingStatus: "Furnished",
			epcRating: "C",
			photos: [
				"https://images.unsplash.com/photo-1560185007-c5ca9d2c014d",
				"https://images.unsplash.com/photo-1586023492125-27b2c045efd7"
			],
			formattedAddress: "12 Gower Street, London WC1E 6BT, UK",
			coordinates: [-0.1321, 51.5246]
		}),
		listing({
			_id: ids.listingUnverified,
			landlord: ids.landlord,
			propertyTitle: "Unverified landlord preview listing",
			numOfPeople: 2,
			sizeSqMeters: 50,
			propertyType: "HOUSE",
			bedroomsCount: 2,
			bathrooms: 1,
			propertyDesc: "Seed record for the superuser verification queue.",
			amenities: ["WiFi", "Parking"],
			streetAddress: "1 Review Lane",
			cityTown: "Edinburgh",
			postcodeZIP: "EH1 1AA",
			country: "United Kingdom",
			monthlyRent: 1400,
			securityDeposit: 1400,
			availableFrom: daysFromNow(40),
			availableUntil: daysFromNow(390),
			furnishingStatus: "Unfurnished",
			epcRating: "E",
			photos: ["https://images.unsplash.com/photo-1560448075-bb485b067938"],
			isVerified: false,
			formattedAddress: "1 Review Lane, Edinburgh EH1 1AA, UK",
			coordinates: [-3.1883, 55.9533]
		}),
		listing({
			_id: ids.listingDraft,
			landlord: ids.agency,
			propertyTitle: "Draft listing for landlord flow",
			numOfPeople: 1,
			sizeSqMeters: 25,
			propertyType: "OTHER",
			bedroomsCount: 1,
			bathrooms: 1,
			propertyDesc: "Seed draft that is automatically removed by Mongo TTL after seven days.",
			amenities: [],
			streetAddress: "99 Draft Street",
			cityTown: "Glasgow",
			postcodeZIP: "G1 1AA",
			country: "United Kingdom",
			monthlyRent: 700,
			securityDeposit: 700,
			availableFrom: daysFromNow(60),
			availableUntil: daysFromNow(420),
			furnishingStatus: "Part-Furnished",
			epcRating: "F",
			photos: [],
			isVerified: false,
			isDraft: true,
			formattedAddress: "99 Draft Street, Glasgow G1 1AA, UK",
			coordinates: [-4.2518, 55.8642]
		})
	];

	const messages = [
		{
			_id: ids.messageOne,
			sender: ids.student,
			messageType: "Text",
			data: "Hi, I am interested in viewing the Marchmont flat next week.",
			createdAt: daysAgo(1),
			conversation: ids.conversation,
			seenUsers: [ids.student],
			deliveredTo: [ids.landlord]
		},
		{
			_id: ids.messageTwo,
			sender: ids.landlord,
			messageType: "Text",
			data: "Thanks Maya, I can do Tuesday afternoon or Thursday morning.",
			createdAt: now,
			conversation: ids.conversation,
			seenUsers: [ids.landlord],
			deliveredTo: [ids.student]
		}
	];

	const conversations = [
		{
			_id: ids.conversation,
			name: "Maya Student's application to Bright Marchmont flat near the Meadows",
			createdAt: daysAgo(1),
			groupDescription: "",
			avatar: "",
			createdBy: ids.student,
			users: [ids.student, ids.landlord],
			lastMessage: ids.messageTwo
		}
	];

	const applications = [
		{
			_id: ids.application,
			listing: ids.listingOne,
			conversation: ids.conversation,
			landlord: ids.landlord,
			applicants: [ids.student, ids.studentTwo],
			owner: ids.student,
			createdAt: daysAgo(1),
			stage: "SENT"
		}
	];

	const flags = [
		{
			_id: ids.flag,
			status: "UNDER_REVIEW",
			category: "OTHER",
			reportedUser: ids.landlord,
			createdBy: ids.student,
			text: "Seed report for checking the admin moderation queue.",
			createdAt: now,
			updatedAt: now
		}
	];

	await upsertMany(db.collection("users"), users);
	await upsertMany(db.collection("listings"), listings);
	await upsertMany(db.collection("messages"), messages);
	await upsertMany(db.collection("conversations"), conversations);
	await upsertMany(db.collection("applications"), applications);
	await upsertMany(db.collection("flags"), flags);

	console.log("Seed complete.");
	console.log("Login emails: admin@seek.local, landlord@st-andrews.ac.uk, agency@seek.local, student@seek.local");
	console.log("Password for all seed users: Password123!");
}

async function upsertMany(collection, records) {
	if (records.length === 0) {
		return;
	}

	await collection.bulkWrite(
		records.map(record => ({
			updateOne: {
				filter: { _id: record._id },
				update: { $set: record },
				upsert: true
			}
		}))
	);
}

async function reset(db) {
	for (const collectionName of COLLECTIONS) {
		await db.collection(collectionName).deleteMany({});
	}
	console.log(`Cleared collections: ${COLLECTIONS.join(", ")}`);
}

async function main() {
	loadEnv();

	const command = process.argv[2] || "seed";
	const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/seek";

	await mongoose.connect(uri);
	const db = mongoose.connection.db;

	try {
		if (command === "reset") {
			await reset(db);
			await createIndexes(db);
			await seed(db);
			return;
		}

		if (command === "seed") {
			await createIndexes(db);
			await seed(db);
			return;
		}

		if (command === "indexes") {
			await createIndexes(db);
			console.log("Indexes created.");
			return;
		}

		throw new Error(`Unknown command "${command}". Use seed, reset, or indexes.`);
	} finally {
		await mongoose.disconnect();
	}
}

main().catch(error => {
	console.error(error);
	process.exitCode = 1;
});
