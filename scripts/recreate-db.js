const fs = require("node:fs");
const path = require("node:path");
const mongoose = require("mongoose");
const { hash } = require("bcryptjs");
const { createHash, createHmac, randomUUID } = require("node:crypto");

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
	flag: oid("665000000000000000000501"),
	// Bristol household and landlord used by the tenancy, payments and
	// landlord dashboard flows.
	tom: oid("665000000000000000000006"),
	leah: oid("665000000000000000000007"),
	sami: oid("665000000000000000000008"),
	priya: oid("665000000000000000000009"),
	james: oid("665000000000000000000010"),
	priyaShah: oid("665000000000000000000011"),
	cotham: oid("665000000000000000000111"),
	kingsdown: oid("665000000000000000000112"),
	redland: oid("665000000000000000000113"),
	clifton: oid("665000000000000000000114"),
	gloucester: oid("665000000000000000000115"),
	cathays: oid("665000000000000000000116"),
	cothamConversation: oid("665000000000000000000211"),
	kingsdownConversation: oid("665000000000000000000212"),
	leoConversation: oid("665000000000000000000213"),
	cothamApplication: oid("665000000000000000000411"),
	kingsdownApplication: oid("665000000000000000000412"),
	leoApplication: oid("665000000000000000000413"),
	gloucesterApplication: oid("665000000000000000000414"),
	cothamTenancy: oid("665000000000000000000601"),
	redlandTenancy: oid("665000000000000000000602"),
	cathaysTenancy: oid("665000000000000000000603"),
	signedContract: oid("665000000000000000000701"),
	draftContract: oid("665000000000000000000702"),
	cathaysContract: oid("665000000000000000000703"),
	redlandContract: oid("665000000000000000000704"),
	boilerRepair: oid("665000000000000000000801"),
	dampRepair: oid("665000000000000000000802"),
	// Demo mailboxes (provider DEMO) and the household group chat.
	mayaMailbox: oid("665000000000000000000a01"),
	jamesMailbox: oid("665000000000000000000a02"),
	cothamMessage: oid("665000000000000000000311"),
	kingsdownMessage: oid("665000000000000000000312")
};

const COLLECTIONS = [
	"users",
	"listings",
	"conversations",
	"messages",
	"applications",
	"flags",
	"tenancies",
	"contracts",
	"rentplans",
	"payments",
	"bills",
	"repairs",
	"notifications",
	"documentshares",
	"emailconnections",
	"emailmessages"
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
		db.collection("messages").createIndex({ sender: 1, createdAt: -1 }),
		db.collection("tenancies").createIndex({ landlord: 1 }),
		db.collection("tenancies").createIndex({ tenants: 1 }),
		db.collection("tenancies").createIndex(
			{ application: 1 },
			{ unique: true, partialFilterExpression: { application: { $type: "objectId" } } }
		),
		db.collection("rentplans").createIndex({ tenancy: 1, tenant: 1 }, { unique: true }),
		db.collection("payments").createIndex({ tenant: 1, dueDate: 1 }),
		db.collection("payments").createIndex({ landlord: 1, dueDate: 1 }),
		db.collection("payments").createIndex({ status: 1, dueDate: 1 }),
		db.collection("notifications").createIndex({ user: 1, createdAt: -1 }),
		db.collection("emailconnections").createIndex({ user: 1, provider: 1, emailAddress: 1 }, { unique: true }),
		db.collection("emailmessages").createIndex({ connection: 1, providerMessageId: 1 }, { unique: true }),
		db.collection("emailmessages").createIndex({ user: 1, receivedAt: -1 }),
		db.collection("notifications").createIndex(
			{ user: 1, dedupeKey: 1 },
			{ unique: true, partialFilterExpression: { dedupeKey: { $type: "string" } } }
		),
		db.collection("documentshares").createIndex(
			{ owner: 1, application: 1 },
			{ unique: true, partialFilterExpression: { application: { $exists: true } } }
		),
		db.collection("documentshares").createIndex({ viewer: 1, owner: 1, expiresAt: 1 })
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
	coordinates,
	nation = "ENGLAND",
	billsIncluded = false,
	compliance = {},
	requirements,
	viewingSlots,
	viewingSlotCapacity = 1,
	holdingDeposit,
	criteria,
	views
}) {
	const now = new Date();
	// Published listings get three upcoming viewing times unless the listing sets its own.
	viewingSlots ??= isDraft ? [] : [3, 5, 9].map((days, index) => {
		const slot = new Date(Date.now() + days * ONE_DAY_MS);
		slot.setUTCHours([17, 17, 11][index], index === 1 ? 30 : 0, 0, 0);
		return slot;
	});
	// Per room, in whole pounds, rounded down to £10 and never above one week's rent.
	holdingDeposit ??= Math.floor((monthlyRent * 12) / 52 / Math.max(1, numOfPeople) / 10) * 10;
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
		nation,
		billsIncluded,
		viewingSlots,
		viewingSlotCapacity,
		holdingDeposit,
		criteria: { guarantor: "UK_OR_SERVICE", referencesRequired: false, maxHousehold: numOfPeople, ...criteria },
		gasSafetyExpiry: compliance.gasSafetyExpiry ?? null,
		eicrExpiry: compliance.eicrExpiry ?? null,
		epcExpiry: compliance.epcExpiry ?? null,
		hmoLicenceExpiry: compliance.hmoLicenceExpiry ?? null,
		licenceNumber: compliance.licenceNumber ?? "",
		requirements: requirements ?? [
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
		views: views ?? (isDraft ? 0 : 150),
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
	// No default. A password baked into a committed file becomes a known
	// credential on every database this script is ever pointed at.
	const seedPassword = process.env.SEED_PASSWORD;
	if (!seedPassword) {
		throw new Error(
			"SEED_PASSWORD must be set. Choose a local development password; " +
			"it is used for every seeded account, including the superuser."
		);
	}
	const password = await hash(seedPassword, 10);
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
			name: "Maya Rahman",
			email: "maya.student@st-andrews.ac.uk",
			password,
			role: "STUDENT",
			isVerified: true,
			isGoogle: false,
			documents: passportDocuments(ids.student, {
				PASSPORT: "VERIFIED",
				RIGHT_TO_RENT: "VERIFIED",
				VISA: "VERIFIED",
				STUDENT_STATUS: "VERIFIED",
				CAS_LETTER: "VERIFIED",
				PROOF_OF_FUNDS: "VERIFIED",
				GUARANTOR_AGREEMENT: "PENDING",
				LANDLORD_REFERENCE: "VERIFIED"
			}),
			profilePicUrl: "https://i.pravatar.cc/200?img=32",
			lastSeen: now,
			createdAt: now,
			updatedAt: now
		},
		{
			_id: ids.studentTwo,
			name: "Leo Applicant",
			email: "leo.applicant@st-andrews.ac.uk",
			password,
			role: "STUDENT",
			isVerified: true,
			isGoogle: false,
			documents: passportDocuments(ids.studentTwo, {
				PASSPORT: "VERIFIED",
				RIGHT_TO_RENT: "VERIFIED",
				STUDENT_STATUS: "VERIFIED",
				PROOF_OF_FUNDS: "VERIFIED"
			}),
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

	users.push(
		student(password, ids.tom, "Tom Ellis", "tom.ellis@st-andrews.ac.uk", 33, passportDocuments(ids.tom, FULL_PASSPORT)),
		student(password, ids.leah, "Leah Okafor", "leah.okafor@st-andrews.ac.uk", 47, passportDocuments(ids.leah, FULL_PASSPORT)),
		student(password, ids.sami, "Sami Haddad", "sami.haddad@st-andrews.ac.uk", 52, passportDocuments(ids.sami, FULL_PASSPORT)),
		student(password, ids.priya, "Priya Nair", "priya.nair@st-andrews.ac.uk", 24, passportDocuments(ids.priya, {
			PASSPORT: "VERIFIED",
			RIGHT_TO_RENT: "VERIFIED",
			STUDENT_STATUS: "VERIFIED",
			PROOF_OF_FUNDS: "VERIFIED"
		})),
		{
			_id: ids.james,
			name: "James Holloway",
			email: "james@seek.local",
			password,
			role: "LANDLORD_AGENCY",
			isVerified: true,
			isGoogle: false,
			documents: [],
			companyName: "Holloway Lets",
			registrations: [
				{ kind: "HMO_LICENCE", number: "HMO/2024/0917", verified: true },
				{ kind: "RENT_SMART_WALES", number: "LR-3381-22", verified: true }
			],
			// Priya Shah, the agent who helps with viewings and the inbox. Never payouts.
			team: [{ _id: oid("665000000000000000000c01"), email: "priya.shah@seek.local", scopes: ["VIEWINGS_INBOX"], user: ids.priyaShah, invitedAt: daysAgo(120) }],
			notificationPrefs: {
				rentReminderDaysBefore: 3,
				receiptEveryPayment: true,
				landlordEveryPayment: true,
				newQualifiedHousehold: true,
				complianceDue: true,
				weeklySummary: false
			},
			profilePicUrl: "https://i.pravatar.cc/200?img=60",
			lastSeen: now,
			createdAt: daysAgo(400),
			updatedAt: now
		},
		{
			_id: ids.priyaShah,
			name: "Priya Shah",
			email: "priya.shah@seek.local",
			password,
			role: "LANDLORD_AGENCY",
			isVerified: true,
			isGoogle: false,
			documents: [],
			companyName: "Holloway Lets",
			lastSeen: daysAgo(1),
			createdAt: daysAgo(120),
			updatedAt: now
		}
	);

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
			nation: "SCOTLAND",
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
			nation: "SCOTLAND",
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
			criteria: { guarantor: "UK_ONLY" },
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
			nation: "SCOTLAND",
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
			nation: "SCOTLAND",
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

	listings.push(...bristolListings());
	const bristol = bristolRecords(now);
	conversations.push(...bristol.conversations);
	applications.push(...bristol.applications);
	messages.push(...bristol.messages);
	const mail = emailRecords(now);

	await upsertMany(db.collection("users"), users);
	await upsertMany(db.collection("listings"), listings);
	await upsertMany(db.collection("messages"), messages);
	await upsertMany(db.collection("conversations"), conversations);
	await upsertMany(db.collection("applications"), applications);
	await upsertMany(db.collection("flags"), flags);
	await upsertMany(db.collection("tenancies"), bristol.tenancies);
	await upsertMany(db.collection("rentplans"), bristol.rentPlans);
	await upsertMany(db.collection("payments"), bristol.payments);
	await upsertMany(db.collection("bills"), bristol.bills);
	await upsertMany(db.collection("contracts"), bristol.contracts);
	await upsertMany(db.collection("repairs"), bristol.repairs);
	await upsertMany(db.collection("documentshares"), bristol.shares);
	await upsertMany(db.collection("notifications"), bristol.notifications);
	await upsertMany(db.collection("emailconnections"), mail.connections);
	await upsertMany(db.collection("emailmessages"), mail.messages);

	console.log("Seed complete.");
	console.log(
		"Login emails: admin@seek.local, landlord@st-andrews.ac.uk, agency@seek.local, " +
		"maya.student@st-andrews.ac.uk (Maya), tom.ellis@, leah.okafor@, sami.haddad@, priya.nair@, leo.applicant@ (Leo) — all @st-andrews.ac.uk, web sign-in takes the part before the @, james@seek.local (landlord), priya.shah@ (James's agent)"
	);
	console.log("Password for all seed users: the SEED_PASSWORD value from .env");
}

const FULL_PASSPORT = {
	PASSPORT: "VERIFIED",
	RIGHT_TO_RENT: "VERIFIED",
	STUDENT_STATUS: "VERIFIED",
	PROOF_OF_FUNDS: "VERIFIED",
	GUARANTOR_AGREEMENT: "VERIFIED"
};

const DOCUMENT_LABELS = {
	PASSPORT: "Passport",
	RIGHT_TO_RENT: "Right to Rent share code",
	VISA: "eVisa",
	STUDENT_STATUS: "Student status letter",
	CAS_LETTER: "CAS letter",
	GUARANTOR_AGREEMENT: "UK guarantor (Housing Hand)",
	PROOF_OF_FUNDS: "Bank statement",
	LANDLORD_REFERENCE: "Previous landlord reference",
	AGENT_REFERENCE: "Letting agent reference",
	RECOMMENDATION: "Recommendation letter"
};

/** Seek Passport documents. Keys follow the private/<ownerId>/<uuid>.pdf layout. */
function passportDocuments(ownerId, statuses) {
	return Object.entries(statuses).map(([type, status], index) => {
		const key = `private/${ownerId.toString()}/${randomUUID()}.pdf`;
		return {
			type,
			status,
			label: DOCUMENT_LABELS[type],
			url: `https://example.com/local/${key}`,
			key,
			uploadedAt: daysAgo(60 - index),
			expiresAt: type === "PASSPORT" ? daysFromNow(365 * 6) : type === "RIGHT_TO_RENT" ? daysFromNow(300) : null
		};
	});
}

function student(password, _id, name, email, avatar, documents) {
	const now = new Date();
	return {
		_id,
		name,
		email,
		password,
		role: "STUDENT",
		isVerified: true,
		isGoogle: false,
		documents,
		profilePicUrl: `https://i.pravatar.cc/200?img=${avatar}`,
		lastSeen: daysAgo(1),
		createdAt: daysAgo(120),
		updatedAt: now
	};
}

function bristolListings() {
	const bristol = {
		landlord: ids.james,
		cityTown: "Bristol",
		country: "United Kingdom",
		furnishingStatus: "Furnished",
		amenities: ["WiFi", "Washing_Machine", "Dishwasher", "Smoke_Alarm"],
		requirements: [
			{ name: "Passport", desc: "Photo identification for Right to Rent checks.", required: true },
			{ name: "Proof of student status", desc: "Enrolment letter for council tax exemption.", required: true },
			{ name: "Guarantor", desc: "UK guarantor or a guarantor service.", required: false }
		]
	};
	return [
		listing({
			...bristol,
			_id: ids.cotham,
			views: 412,
			propertyTitle: "14 Cotham Grove",
			numOfPeople: 4,
			sizeSqMeters: 118,
			propertyType: "HOUSE",
			bedroomsCount: 4,
			bathrooms: 2,
			propertyDesc: "Four double bedrooms on a quiet street, ten minutes' walk to the Precinct. Energy, water and broadband included.",
			streetAddress: "14 Cotham Grove",
			postcodeZIP: "BS6 6AL",
			monthlyRent: 2780,
			securityDeposit: 3204,
			availableFrom: new Date("2026-09-01T00:00:00Z"),
			availableUntil: new Date("2027-06-30T00:00:00Z"),
			epcRating: "C",
			photos: [
				"https://images.unsplash.com/photo-1568605114967-8130f3a36994",
				"https://images.unsplash.com/photo-1600585154340-be6161a56a0c"
			],
			formattedAddress: "14 Cotham Grove, Bristol BS6 6AL, UK",
			coordinates: [-2.6005, 51.4655],
			billsIncluded: true,
			compliance: {
				gasSafetyExpiry: daysFromNow(240),
				eicrExpiry: daysFromNow(900),
				epcExpiry: daysFromNow(2400),
				hmoLicenceExpiry: daysFromNow(700),
				licenceNumber: "HMO/2024/0917"
			}
		}),
		listing({
			...bristol,
			_id: ids.kingsdown,
			views: 288,
			propertyTitle: "22 Kingsdown Parade",
			numOfPeople: 4,
			sizeSqMeters: 104,
			propertyType: "HOUSE",
			bedroomsCount: 4,
			bathrooms: 2,
			propertyDesc: "Georgian terrace with city views, a short walk to the Royal Infirmary and the Richmond Building.",
			streetAddress: "22 Kingsdown Parade",
			postcodeZIP: "BS6 5UF",
			monthlyRent: 2640,
			securityDeposit: 3040,
			availableFrom: new Date("2027-07-01T00:00:00Z"),
			availableUntil: new Date("2028-06-30T00:00:00Z"),
			epcRating: "D",
			photos: ["https://images.unsplash.com/photo-1580587771525-78b9dba3b914"],
			formattedAddress: "22 Kingsdown Parade, Bristol BS6 5UF, UK",
			coordinates: [-2.5937, 51.4613],
			// Open-house slots: two households can view at once. The middle one is Maya's booked viewing.
			viewingSlots: [2, 4, 6].map((days, index) => {
				const slot = new Date(Date.now() + days * ONE_DAY_MS);
				slot.setUTCHours([17, 17, 12][index], index === 1 ? 30 : 0, 0, 0);
				return slot;
			}),
			viewingSlotCapacity: 2,
			criteria: { guarantor: "NONE" },
			compliance: {
				gasSafetyExpiry: daysFromNow(150),
				eicrExpiry: daysFromNow(21),
				epcExpiry: daysFromNow(1800),
				hmoLicenceExpiry: daysFromNow(500),
				licenceNumber: "HMO/2023/0412"
			}
		}),
		listing({
			...bristol,
			_id: ids.redland,
			propertyTitle: "Flat 2, 8 Redland Road",
			numOfPeople: 2,
			sizeSqMeters: 61,
			propertyType: "FLAT_APARTMENT",
			bedroomsCount: 2,
			bathrooms: 1,
			propertyDesc: "Two bedroom first floor flat near Redland station.",
			streetAddress: "Flat 2, 8 Redland Road",
			postcodeZIP: "BS6 6AG",
			monthlyRent: 1500,
			securityDeposit: 1700,
			availableFrom: daysAgo(26),
			availableUntil: daysFromNow(339),
			epcRating: "C",
			photos: ["https://images.unsplash.com/photo-1502672260266-1c1ef2d93688"],
			formattedAddress: "Flat 2, 8 Redland Road, Bristol BS6 6AG, UK",
			coordinates: [-2.6012, 51.4721],
			compliance: {
				gasSafetyExpiry: daysFromNow(200),
				eicrExpiry: daysFromNow(1200),
				epcExpiry: daysFromNow(2000)
			}
		}),
		listing({
			...bristol,
			_id: ids.clifton,
			propertyTitle: "Clifton studio with balcony",
			numOfPeople: 1,
			criteria: { guarantor: "UK_ONLY", referencesRequired: true },
			sizeSqMeters: 30,
			propertyType: "STUDIO",
			bedroomsCount: 1,
			bathrooms: 1,
			propertyDesc: "Bright studio by the Triangle, five minutes from the Wills Memorial Building.",
			streetAddress: "31 Princess Victoria Street",
			postcodeZIP: "BS8 4BX",
			monthlyRent: 1050,
			securityDeposit: 1200,
			availableFrom: daysFromNow(30),
			availableUntil: daysFromNow(395),
			epcRating: "B",
			photos: ["https://images.unsplash.com/photo-1554995207-c18c203602cb"],
			formattedAddress: "31 Princess Victoria Street, Bristol BS8 4BX, UK",
			coordinates: [-2.6202, 51.4558],
			billsIncluded: true,
			compliance: {
				gasSafetyExpiry: daysFromNow(320),
				eicrExpiry: daysFromNow(1400),
				epcExpiry: daysFromNow(2600)
			}
		}),
		listing({
			...bristol,
			_id: ids.gloucester,
			propertyTitle: "9 Gloucester Road",
			numOfPeople: 2,
			sizeSqMeters: 62,
			propertyType: "HOUSE",
			bedroomsCount: 2,
			bathrooms: 1,
			propertyDesc: "Draft: two bedroom maisonette above the shops.",
			streetAddress: "9 Gloucester Road",
			postcodeZIP: "BS7 8AA",
			monthlyRent: 1300,
			securityDeposit: 1500,
			criteria: { guarantor: "NONE" },
			// Per person, in pounds: under one week's rent (£650 a month each).
			holdingDeposit: 140,
			availableFrom: daysFromNow(60),
			availableUntil: daysFromNow(420),
			epcRating: "D",
			photos: [],
			isVerified: false,
			isDraft: true,
			formattedAddress: "9 Gloucester Road, Bristol BS7 8AA, UK",
			coordinates: [-2.5905, 51.4705]
		}),
		listing({
			...bristol,
			_id: ids.cathays,
			cityTown: "Cardiff",
			nation: "WALES",
			propertyTitle: "5 Cathays Terrace",
			numOfPeople: 3,
			criteria: { referencesRequired: true },
			sizeSqMeters: 90,
			propertyType: "HOUSE",
			bedroomsCount: 3,
			bathrooms: 1,
			propertyDesc: "Three bedroom terrace in Cathays, close to Cardiff University. Six-monthly and yearly rent plans available.",
			streetAddress: "5 Cathays Terrace",
			postcodeZIP: "CF24 4HS",
			monthlyRent: 1440,
			securityDeposit: 1440,
			availableFrom: daysFromNow(45),
			availableUntil: daysFromNow(410),
			epcRating: "C",
			photos: ["https://images.unsplash.com/photo-1572120360610-d971b9d7767c"],
			formattedAddress: "5 Cathays Terrace, Cardiff CF24 4HS, UK",
			coordinates: [-3.1791, 51.4935],
			compliance: {
				gasSafetyExpiry: daysFromNow(180),
				eicrExpiry: daysFromNow(1000),
				epcExpiry: daysFromNow(2200),
				licenceNumber: "RSW-LL-55120"
			}
		})
	];
}

const SEEK_FEE_RATE = 0.005;

/** Same signed link as ContractsService builds (src/contracts/contract-documents.ts). */
function seekDocumentUrl(contractId, doc) {
	const base = (process.env.API_URL || process.env.CONNECTORS_CALLBACK_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, "");
	const secret = process.env.JWT_ACCESS_TOKEN_SECRET || "";
	const sig = createHmac("sha256", secret).update(`${contractId.toString()}:${doc}`).digest("hex");
	return `${base}/contracts/${contractId.toString()}/${doc === "agreement" ? "document" : "prescribed-information"}?sig=${sig}`;
}

function addMonths(anchor, months) {
	const year = anchor.getUTCFullYear();
	const month = anchor.getUTCMonth() + months;
	const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
	return new Date(Date.UTC(year, month, Math.min(anchor.getUTCDate(), lastDay)));
}

/** Monthly payments: past ones paid, the latest of `lateTenants` late, the rest scheduled. */
function monthlyPayments({ tenancy, tenants, landlord, monthlyRent, startDate, endDate, lateTenants = [] }, now) {
	const payments = [];
	const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
	const horizon = addMonths(today, 12);
	tenants.forEach((tenant, tenantIndex) => {
		const dueDates = [];
		for (let i = 0; ; i += 1) {
			const dueDate = addMonths(startDate, i);
			if (dueDate >= endDate || dueDate >= horizon) break;
			dueDates.push(dueDate);
		}
		const lastPast = dueDates.filter(date => date < today).at(-1);
		dueDates.forEach((dueDate, index) => {
			const seekFee = Math.round(monthlyRent * SEEK_FEE_RATE);
			const past = dueDate < today;
			const late = past && lateTenants.some(id => id.equals(tenant)) && dueDate === lastPast;
			const status = !past ? "SCHEDULED" : late ? "LATE" : "PAID";
			payments.push({
				_id: oid(`${tenancy.toString().slice(0, 13)}${tenancy.toString().slice(-3)}${String(tenantIndex).padStart(2, "0")}${String(index).padStart(6, "0")}`),
				tenancy,
				tenant,
				landlord,
				amount: monthlyRent,
				seekFee,
				payout: monthlyRent - seekFee,
				coversMonths: 1,
				status,
				dueDate,
				paidAt: status === "PAID" ? new Date(dueDate.getTime() - (tenantIndex % 2) * ONE_DAY_MS) : null,
				provider: status === "PAID" ? "simulated" : null,
				providerRef: status === "PAID" ? `sim_seed_${tenantIndex}_${index}` : null,
				createdAt: startDate,
				updatedAt: now
			});
		});
	});
	return payments;
}

function bristolRecords(now) {
	const household = [ids.student, ids.tom, ids.leah, ids.sami];
	const cothamStart = new Date("2026-09-01T00:00:00Z");
	const cothamEnd = new Date("2027-06-30T00:00:00Z");
	const redlandStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 26));
	const redlandEnd = addMonths(redlandStart, 12);
	const sentAt = daysAgo(3);
	const leoSentAt = daysAgo(2);
	const viewingAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 4, 17, 30));
	const offeredAt = daysAgo(13);
	const offerExpiresAt = new Date(offeredAt.getTime() + 15 * ONE_DAY_MS);
	// Leo's household lived at 5 Cathays Terrace (Wales) until last week.
	const cathaysEnd = daysAgo(5);
	const cathaysStart = addMonths(cathaysEnd, -12);
	const doc = (type, title, slug, extra = {}) => ({
		type,
		title,
		url: `https://example.com/local/tenancy/${slug}.pdf`,
		key: `private/${ids.james.toString()}/${slug}.pdf`,
		source: "UPLOAD",
		addedAt: daysAgo(70),
		...extra
	});

	const conversations = [
		{
			_id: ids.cothamConversation,
			name: "Maya Rahman's application to 14 Cotham Grove",
			createdAt: daysAgo(120),
			groupDescription: "",
			avatar: "",
			createdBy: ids.student,
			users: [...household, ids.james],
			lastMessage: ids.cothamMessage
		},
		{
			_id: ids.kingsdownConversation,
			name: "Maya Rahman's application to 22 Kingsdown Parade",
			createdAt: daysAgo(5),
			groupDescription: "",
			avatar: "",
			createdBy: ids.student,
			users: [...household, ids.james],
			lastMessage: ids.kingsdownMessage
		},
		{
			_id: ids.leoConversation,
			name: "Leo Applicant's application to 22 Kingsdown Parade",
			createdAt: daysAgo(4),
			groupDescription: "",
			avatar: "",
			createdBy: ids.studentTwo,
			users: [ids.studentTwo, ids.priya, ids.james]
		}
	];

	const applications = [
		{
			_id: ids.cothamApplication,
			listing: ids.cotham,
			conversation: ids.cothamConversation,
			landlord: ids.james,
			applicants: household,
			owner: ids.student,
			applicationKey: `${ids.cotham.toString()}:${ids.student.toString()}`,
			createdAt: daysAgo(120),
			sentAt: daysAgo(118),
			viewingAt: daysAgo(112),
			stage: "ACCEPTED"
		},
		{
			_id: ids.kingsdownApplication,
			listing: ids.kingsdown,
			conversation: ids.kingsdownConversation,
			landlord: ids.james,
			applicants: household,
			owner: ids.student,
			applicationKey: `${ids.kingsdown.toString()}:${ids.student.toString()}`,
			createdAt: daysAgo(5),
			sentAt,
			viewingAt,
			stage: "SENT"
		},
		{
			_id: ids.leoApplication,
			listing: ids.kingsdown,
			conversation: ids.leoConversation,
			landlord: ids.james,
			applicants: [ids.studentTwo, ids.priya],
			owner: ids.studentTwo,
			applicationKey: `${ids.kingsdown.toString()}:${ids.studentTwo.toString()}`,
			createdAt: daysAgo(4),
			sentAt: leoSentAt,
			viewingAt: null,
			stage: "SENT"
		},
		// Leo's household viewed Gloucester Road and holds an offer: each pays a holding deposit.
		{
			_id: ids.gloucesterApplication,
			listing: ids.gloucester,
			landlord: ids.james,
			applicants: [ids.studentTwo, ids.priya],
			owner: ids.studentTwo,
			applicationKey: `${ids.gloucester.toString()}:${ids.studentTwo.toString()}`,
			createdAt: daysAgo(12),
			sentAt: daysAgo(11),
			viewingAt: daysAgo(6),
			offeredAt: offeredAt,
			offerExpiresAt,
			holdingDeposit: 140,
			stage: "OFFERED"
		}
	];

	const tenancies = [
		{
			_id: ids.cothamTenancy,
			listing: ids.cotham,
			landlord: ids.james,
			tenants: household,
			application: ids.cothamApplication,
			startDate: cothamStart,
			endDate: cothamEnd,
			periodic: false,
			monthlyRent: 69500,
			depositAmount: 80100,
			// Household energy fair-use allowance (pence per month); last month's Octopus bill goes over it.
			energyAllowance: 20000,
			depositScheme: "DPS",
			depositReference: "DPS-7781-2209",
			depositProtectedAt: new Date("2026-09-02T00:00:00Z"),
			status: "ACTIVE",
			documents: [
				doc("TENANCY_AGREEMENT", "Tenancy agreement 2026-27", "cotham-agreement-2026", { source: "SEEK" }),
				doc("DEPOSIT_CERTIFICATE", "DPS certificate", "cotham-dps-certificate", { source: "EMAIL" }),
				doc("GAS_SAFETY", "Gas safety 2026", "cotham-gas-safety", { source: "EMAIL" }),
				doc("COUNCIL_TAX_EXEMPTION", "Council tax exemption", "cotham-council-tax-exemption", { source: "EMAIL" }),
				doc("EPC", "Energy performance certificate", "cotham-epc"),
				doc("EICR", "Electrical installation condition report", "cotham-eicr"),
				doc("HOW_TO_RENT", "How to Rent guide", "how-to-rent")
			],
			createdAt: daysAgo(80),
			updatedAt: now
		},
		{
			_id: ids.redlandTenancy,
			listing: ids.redland,
			landlord: ids.james,
			tenants: [ids.studentTwo, ids.priya],
			application: null,
			startDate: redlandStart,
			endDate: redlandEnd,
			periodic: false,
			monthlyRent: 75000,
			depositAmount: 85000,
			depositScheme: null,
			depositReference: "",
			// Received on move-in and not protected yet: 4 days left of the 30-day deadline.
			depositReceivedAt: redlandStart,
			depositProtectedAt: null,
			status: "ACTIVE",
			documents: [doc("TENANCY_AGREEMENT", "Tenancy agreement", "redland-agreement")],
			createdAt: redlandStart,
			updatedAt: now
		},
		{
			_id: ids.cathaysTenancy,
			listing: ids.cathays,
			landlord: ids.james,
			tenants: [ids.studentTwo, ids.priya],
			application: null,
			startDate: cathaysStart,
			endDate: cathaysEnd,
			periodic: true,
			monthlyRent: 48000,
			depositAmount: 48000,
			depositScheme: "TDS",
			depositReference: "TDS-4410-0193",
			depositReceivedAt: cathaysStart,
			depositProtectedAt: new Date(cathaysStart.getTime() + 6 * ONE_DAY_MS),
			prescribedInfoSentAt: new Date(cathaysStart.getTime() + 6 * ONE_DAY_MS),
			status: "ENDED",
			documents: [],
			createdAt: cathaysStart,
			updatedAt: now
		}
	];

	const rentPlans = [
		...household.map(tenant => ({
			_id: oid(`6650000000000000000c${tenant.toString().slice(-4)}`),
			tenancy: ids.cothamTenancy,
			tenant,
			frequency: "MONTHLY",
			autopay: !tenant.equals(ids.sami),
			notifyEveryPayment: true,
			remindDaysBefore: 3,
			createdAt: cothamStart,
			updatedAt: now
		})),
		...[ids.studentTwo, ids.priya].map(tenant => ({
			_id: oid(`6650000000000000000d${tenant.toString().slice(-4)}`),
			tenancy: ids.redlandTenancy,
			tenant,
			frequency: "MONTHLY",
			autopay: false,
			notifyEveryPayment: true,
			remindDaysBefore: 3,
			createdAt: redlandStart,
			updatedAt: now
		}))
	];

	const payments = [
		...monthlyPayments({
			tenancy: ids.cothamTenancy,
			tenants: household,
			landlord: ids.james,
			monthlyRent: 69500,
			startDate: cothamStart,
			endDate: cothamEnd,
			lateTenants: [ids.sami]
		}, now),
		...monthlyPayments({
			tenancy: ids.redlandTenancy,
			tenants: [ids.studentTwo, ids.priya],
			landlord: ids.james,
			monthlyRent: 75000,
			startDate: redlandStart,
			endDate: redlandEnd
		}, now),
		// Holding deposits for the Gloucester Road offer: Priya has paid, Leo has not yet.
		...[ids.studentTwo, ids.priya].map((tenant, index) => {
			const paid = tenant.equals(ids.priya);
			return {
				_id: oid(`6650000000000000000e000${index}`),
				kind: "HOLDING_DEPOSIT",
				tenancy: null,
				application: ids.gloucesterApplication,
				tenant,
				landlord: ids.james,
				amount: 14000,
				// Seek's fee is on rent only: the landlord keeps the whole holding deposit.
				seekFee: 0,
				payout: 14000,
				coversMonths: 1,
				status: paid ? "PAID" : "SCHEDULED",
				dueDate: offerExpiresAt,
				paidAt: paid ? daysAgo(0.5) : null,
				provider: paid ? "simulated" : null,
				providerRef: paid ? "sim_seed_holding_priya" : null,
				createdAt: offeredAt,
				updatedAt: now
			};
		})
	];

	const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
	const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
	const bill = (n, fields) => ({
		_id: oid(`66500000000000000000090${n}`),
		tenancy: ids.cothamTenancy,
		periodStart: monthStart,
		periodEnd: monthEnd,
		splitBetween: household,
		paidShares: [],
		source: "MANUAL",
		createdAt: monthStart,
		updatedAt: now,
		...fields
	});
	const bills = [
		// Filed from the Octopus email in Maya's demo mailbox (last month's statement).
		bill(1, {
			provider: "Octopus Energy",
			category: "ENERGY",
			amount: 21400,
			periodStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)),
			periodEnd: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0, 23, 59, 59)),
			dueDate: null,
			includedInRent: true,
			status: "PAID",
			paidAt: daysAgo(2),
			source: "EMAIL"
		}),
		bill(2, { provider: "Bristol Water", category: "WATER", amount: 4200, dueDate: monthEnd, includedInRent: true, status: "PAID", paidAt: monthStart }),
		bill(3, { provider: "Hyperoptic", category: "BROADBAND", amount: 3500, dueDate: monthEnd, includedInRent: true, status: "PAID", paidAt: monthStart }),
		bill(4, { provider: "TV Licensing", category: "TV_LICENCE", amount: 16950, dueDate: daysFromNow(12), includedInRent: false, status: "DUE", paidAt: null, source: "EMAIL", paidShares: [ids.student, ids.tom] }),
		// A shared extra Tom fronted: the others owe him their share.
		bill(5, { provider: "Cleaner", category: "OTHER", amount: 6000, dueDate: null, includedInRent: false, status: "DUE", paidAt: null, paidBy: ids.tom, paidShares: [ids.tom] })
	];

	const contracts = [
		{
			_id: ids.signedContract,
			tenancy: ids.cothamTenancy,
			landlord: ids.james,
			title: "Tenancy agreement 2026-27",
			url: "https://example.com/local/tenancy/cotham-agreement-2026.pdf",
			key: `private/${ids.james.toString()}/cotham-agreement-2026.pdf`,
			source: "UPLOAD",
			status: "SIGNED",
			signatures: household.map((user, index) => ({ user, signedAt: daysAgo(90 - index) })),
			sentAt: daysAgo(92),
			signedAt: daysAgo(87),
			inventory: {
				recordedAt: cothamStart,
				items: [
					{ room: "Kitchen", item: "Oven and hob", condition: "Clean, all rings working", photoUrls: [] },
					{ room: "Living room", item: "Sofa", condition: "Good, small worn patch on left arm", photoUrls: [] },
					{ room: "Bedroom 2", item: "Walls and window", condition: "Freshly painted, no damp", photoUrls: [] },
					{ room: "Bathroom", item: "Shower and extractor fan", condition: "Working, sealant clean", photoUrls: [] }
				]
			},
			deductions: null,
			createdAt: daysAgo(93),
			updatedAt: daysAgo(87)
		},
		// Seek's Welsh occupation contract for the ended Cathays tenancy, with move-out deductions.
		{
			_id: ids.cathaysContract,
			tenancy: ids.cathaysTenancy,
			landlord: ids.james,
			title: "Standard occupation contract (Wales)",
			url: seekDocumentUrl(ids.cathaysContract, "agreement"),
			prescribedInformationUrl: seekDocumentUrl(ids.cathaysContract, "prescribed-information"),
			templateKind: "WALES_STANDARD_OCCUPATION",
			source: "SEEK",
			status: "SIGNED",
			signatures: [ids.studentTwo, ids.priya].map(user => ({ user, signedAt: new Date(cathaysStart.getTime() - 10 * ONE_DAY_MS) })),
			sentAt: new Date(cathaysStart.getTime() - 12 * ONE_DAY_MS),
			signedAt: new Date(cathaysStart.getTime() - 10 * ONE_DAY_MS),
			inventory: {
				recordedAt: cathaysStart,
				items: [
					{ room: "Kitchen", item: "Oven", condition: "Clean", photoUrls: [] },
					{ room: "Bedroom 1", item: "Desk chair", condition: "Good, no damage", photoUrls: [] },
					{ room: "Hallway", item: "Carpet", condition: "Light wear", photoUrls: [] }
				]
			},
			deductions: {
				items: [
					{ description: "Professional clean of the oven", amount: 9000 },
					{ description: "Replace broken desk chair in bedroom 1", amount: 4500 }
				],
				total: 13500,
				status: "PROPOSED",
				responses: [{ user: ids.priya, accepted: true, at: daysAgo(1) }],
				proposedAt: daysAgo(2)
			},
			createdAt: new Date(cathaysStart.getTime() - 12 * ONE_DAY_MS),
			updatedAt: daysAgo(1)
		},
		// Seek's England agreement for the active Redland tenancy, with the move-in inventory.
		{
			_id: ids.redlandContract,
			tenancy: ids.redlandTenancy,
			landlord: ids.james,
			title: "Assured periodic tenancy agreement (England)",
			url: seekDocumentUrl(ids.redlandContract, "agreement"),
			prescribedInformationUrl: seekDocumentUrl(ids.redlandContract, "prescribed-information"),
			templateKind: "ENGLAND_ASSURED_PERIODIC",
			source: "SEEK",
			status: "SIGNED",
			signatures: [ids.studentTwo, ids.priya].map(user => ({ user, signedAt: new Date(redlandStart.getTime() - 7 * ONE_DAY_MS) })),
			sentAt: new Date(redlandStart.getTime() - 9 * ONE_DAY_MS),
			signedAt: new Date(redlandStart.getTime() - 7 * ONE_DAY_MS),
			inventory: {
				recordedAt: redlandStart,
				items: [
					{ room: "Living room", item: "Sofa", condition: "Good, small mark on left arm", photoUrls: [] },
					{ room: "Kitchen", item: "Fridge freezer", condition: "Clean, working", photoUrls: [] },
					{ room: "Bedroom 1", item: "Double bed and mattress", condition: "Good", photoUrls: [] },
					{ room: "Bathroom", item: "Shower screen", condition: "Hairline crack, noted at move-in", photoUrls: [] }
				]
			},
			deductions: null,
			createdAt: new Date(redlandStart.getTime() - 9 * ONE_DAY_MS),
			updatedAt: new Date(redlandStart.getTime() - 7 * ONE_DAY_MS)
		},
		{
			_id: ids.draftContract,
			tenancy: ids.cothamTenancy,
			landlord: ids.james,
			title: "Tenancy agreement 2027-28",
			url: "https://example.com/local/tenancy/cotham-agreement-2027.pdf",
			key: `private/${ids.james.toString()}/cotham-agreement-2027.pdf`,
			source: "UPLOAD",
			status: "DRAFT",
			signatures: [],
			sentAt: null,
			signedAt: null,
			templateKind: null,
			prescribedInformationUrl: null,
			inventory: null,
			deductions: null,
			createdAt: daysAgo(1),
			updatedAt: daysAgo(1)
		}
	];

	const repairs = [
		{
			_id: ids.boilerRepair,
			tenancy: ids.cothamTenancy,
			landlord: ids.james,
			reportedBy: ids.tom,
			title: "Boiler not heating water",
			description: "Hot water cuts out after a few minutes. Heating works.",
			status: "SCHEDULED",
			scheduledFor: daysFromNow(2),
			fixedAt: null,
			createdAt: daysAgo(3),
			updatedAt: daysAgo(2)
		},
		{
			_id: ids.dampRepair,
			tenancy: ids.cothamTenancy,
			landlord: ids.james,
			reportedBy: ids.leah,
			title: "Damp patch in back bedroom",
			description: "Black mould by the window, getting bigger.",
			status: "OPEN",
			scheduledFor: null,
			fixedAt: null,
			createdAt: daysAgo(1),
			updatedAt: daysAgo(1)
		}
	];

	const shares = [
		...household.map((owner, index) => ({
			_id: oid(`6650000000000000000a000${index}`),
			owner,
			viewer: ids.james,
			listing: ids.kingsdown,
			application: ids.kingsdownApplication,
			expiresAt: new Date(sentAt.getTime() + 14 * ONE_DAY_MS),
			revokedAt: null,
			createdAt: sentAt,
			updatedAt: sentAt
		})),
		...[ids.studentTwo, ids.priya].map((owner, index) => ({
			_id: oid(`6650000000000000000a001${index}`),
			owner,
			viewer: ids.james,
			listing: ids.kingsdown,
			application: ids.leoApplication,
			expiresAt: new Date(leoSentAt.getTime() + 14 * ONE_DAY_MS),
			revokedAt: null,
			createdAt: leoSentAt,
			updatedAt: leoSentAt
		}))
	];

	const latePayment = payments.find(p => p.status === "LATE");
	const lastReceipt = payments.filter(p => p.status === "PAID" && p.tenant.equals(ids.student)).at(-1);
	const notification = (n, fields) => ({
		_id: oid(`6650000000000000000b00${String(n).padStart(2, "0")}`),
		readAt: null,
		createdAt: daysAgo(1),
		updatedAt: daysAgo(1),
		...fields
	});
	// Mirrors notificationTarget() in src/notifications/links.ts so every seeded link opens a real screen.
	const ROUTES = {
		APPLICATION: { student: ["applications", "/student/home", "/(app)/(tabs)/applied"], landlord: ["application", "/applicants"] },
		REPAIRS: { student: ["repairs", "/student/home", "/(app)/repairs"], landlord: ["dashboard", "/dashboard"] },
		PAYMENTS: { student: ["rent", "/student/home/rent", "/(app)/(tabs)/rent"], landlord: ["landlord-rent", "/rent"] },
		COMPLIANCE: { student: ["deposit", "/student/home/deposit", "/(app)/deposit"], landlord: ["dashboard", "/dashboard"] },
		CONTRACTS: { student: ["contract", "/student/home", "/(app)/contract"], landlord: ["contracts", "/contracts"] }
	};
	const target = (audience, kind, id, listing) => {
		const [screen, web, mobile] = ROUTES[kind][audience];
		const link =
			kind === "APPLICATION" && audience === "landlord" && id && listing
				? `/application?listing=${listing.toString()}&id=${id.toString()}`
				: web;
		return {
			link,
			target: {
				kind,
				screen,
				...(id ? { id: id.toString() } : {}),
				...(listing ? { listing: listing.toString() } : {}),
				...(mobile ? { mobile } : {})
			}
		};
	};
	const notifications = [
		notification(1, {
			user: ids.james,
			kind: "NEW_QUALIFIED_HOUSEHOLD",
			title: "New qualified household for 22 Kingsdown Parade",
			body: "4 students, every Seek Passport verified.",
			...target("landlord", "APPLICATION", ids.kingsdownApplication, ids.kingsdown),
			dedupeKey: `qualified:${ids.kingsdownApplication.toString()}`,
			createdAt: sentAt
		}),
		notification(2, {
			user: ids.james,
			kind: "REPAIR_REPORTED",
			title: "Repair reported at 14 Cotham Grove",
			body: "Damp patch in back bedroom",
			...target("landlord", "REPAIRS", ids.cothamTenancy)
		}),
		notification(3, {
			user: ids.student,
			kind: "VIEWING_SCHEDULED",
			title: "Viewing booked for 22 Kingsdown Parade",
			body: "James Holloway set the viewing time.",
			...target("student", "APPLICATION", ids.kingsdownApplication),
			dedupeKey: `viewing:${ids.kingsdownApplication.toString()}:${viewingAt.toISOString()}`
		}),
		notification(6, {
			user: ids.studentTwo,
			kind: "OFFER_MADE",
			title: "Offer for 9 Gloucester Road",
			body: "Pay the £140 holding deposit each to keep it. The offer lapses in 2 days.",
			...target("student", "APPLICATION", ids.gloucesterApplication),
			dedupeKey: `offer:${ids.gloucesterApplication.toString()}`,
			createdAt: offeredAt
		}),
		notification(7, {
			user: ids.studentTwo,
			kind: "DEPOSIT_DEDUCTIONS",
			title: "Your landlord proposed deposit deductions",
			body: "£135.00 from the £960.00 deposit. Accept or dispute them in Seek.",
			...target("student", "COMPLIANCE", ids.cathaysTenancy),
			dedupeKey: `deductions:${ids.cathaysContract.toString()}`,
			createdAt: daysAgo(2)
		}),
		notification(8, {
			user: ids.student,
			kind: "INVENTORY_RECORDED",
			title: "Your check-in inventory is ready",
			body: "4 items recorded. Tell your landlord now if anything is missing or wrong.",
			...target("student", "CONTRACTS", ids.cothamTenancy),
			dedupeKey: `inventory:${ids.signedContract.toString()}`,
			readAt: cothamStart,
			createdAt: cothamStart
		})
	];
	if (lastReceipt) {
		notifications.push(notification(4, {
			user: ids.student,
			kind: "RENT_RECEIPT",
			title: "Receipt: £695.00 rent paid",
			body: "Your landlord has been notified.",
			...target("student", "PAYMENTS", ids.cothamTenancy),
			dedupeKey: `receipt:${lastReceipt._id.toString()}`,
			readAt: lastReceipt.paidAt,
			createdAt: lastReceipt.paidAt
		}));
	}
	if (latePayment) {
		notifications.push(notification(5, {
			user: ids.sami,
			kind: "RENT_LATE",
			title: "Rent of £695.00 is overdue",
			body: "Pay now to keep your record clean.",
			...target("student", "PAYMENTS", ids.cothamTenancy),
			dedupeKey: `late:${latePayment._id.toString()}`
		}));
	}

	// Household group chat: the latest message in each Seek conversation.
	const messages = [
		{
			_id: ids.cothamMessage,
			sender: ids.student,
			messageType: "Text",
			data: "Hi James, the boiler cut out again tonight. Could someone take a look this week?",
			createdAt: new Date(now.getTime() - 3 * 3_600_000),
			conversation: ids.cothamConversation,
			seenUsers: [ids.student],
			deliveredTo: [ids.tom, ids.leah, ids.sami, ids.james]
		},
		{
			_id: ids.kingsdownMessage,
			sender: ids.tom,
			messageType: "Text",
			data: "Passport uploaded! Are we all good for the viewing on Thursday?",
			createdAt: new Date(now.getTime() - 40 * 60_000),
			conversation: ids.kingsdownConversation,
			seenUsers: [ids.tom],
			deliveredTo: [ids.student, ids.leah, ids.sami, ids.james]
		}
	];

	return { conversations, applications, tenancies, rentPlans, payments, bills, contracts, repairs, shares, notifications, messages };
}

const MONTH_NAMES = [
	"January", "February", "March", "April", "May", "June",
	"July", "August", "September", "October", "November", "December"
];

/**
 * Demo mailboxes for Maya and James, as a sync of the DEMO provider stores
 * them (same message ids and thread keys as src/connectors/demo-mailbox.ts),
 * so a later "Sync" from the app imports nothing twice.
 */
function emailRecords(now) {
	const mayaAddress = "maya.rahman@gmail.com";
	const jamesAddress = "james@holloway-lets.co.uk";
	const hoursAgo = hours => new Date(now.getTime() - hours * 3_600_000);
	const lastMonth = MONTH_NAMES[(now.getUTCMonth() + 11) % 12];
	const year = now.getUTCMonth() >= 7 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
	const years = `${year}–${String(year + 1).slice(2)}`;
	const connection = (_id, user, emailAddress) => ({
		_id,
		user,
		provider: "DEMO",
		emailAddress,
		status: "CONNECTED",
		housingOnly: true,
		accessTokenEnc: null,
		refreshTokenEnc: null,
		expiresAt: null,
		lastSyncAt: now,
		lastError: null,
		createdAt: daysAgo(3),
		updatedAt: now
	});
	const file = (name, filedAs) => ({
		name,
		url: `https://example.com/local/email/${encodeURIComponent(name)}`,
		key: null,
		mimeType: "application/pdf",
		size: 0,
		filedAs
	});
	let n = 0;
	const email = (conn, user, mailbox, id, fields) => {
		n += 1;
		const { thread, ...rest } = fields;
		const providerThreadId = `demo-thread-${thread ?? id}`;
		return {
			_id: oid(`665000000000000000000b${String(n).padStart(2, "0")}`),
			user,
			connection: conn,
			providerThreadId,
			providerMessageId: `demo-${id}`,
			internetMessageId: `<demo-${id}@seek.local>`,
			threadKey: createHash("sha256").update(`${conn.toString()}:${providerThreadId}`).digest("hex").slice(0, 24),
			to: [mailbox],
			counterpartEmail: rest.from,
			counterpartName: rest.fromName,
			snippet: rest.body.replace(/\s+/g, " ").slice(0, 140),
			attachments: [],
			tenancy: ids.cothamTenancy,
			conversation: null,
			outgoing: false,
			read: false,
			createdAt: rest.receivedAt,
			updatedAt: now,
			...rest
		};
	};
	const maya = (id, fields) => email(ids.mayaMailbox, ids.student, mayaAddress, id, fields);
	const james = (id, fields) => email(ids.jamesMailbox, ids.james, jamesAddress, id, fields);

	const messages = [
		maya("landlord-boiler", {
			thread: "boiler",
			from: jamesAddress,
			fromName: "James Holloway",
			subject: "Re: Boiler",
			body: "Thanks Maya, sorry about that. The engineer can do Tuesday 9–11am. Gas safety certificate attached for your records.\n\nJames",
			receivedAt: hoursAgo(2),
			category: "LANDLORD",
			conversation: ids.cothamConversation,
			attachments: [file("Gas-safety-2026.pdf", "My home › Documents")]
		}),
		maya("landlord-agreement", {
			thread: "agreement",
			from: jamesAddress,
			fromName: "James Holloway",
			to: [mayaAddress, "tom.ellis@st-andrews.ac.uk", "leah.okafor@st-andrews.ac.uk", "sami.haddad@st-andrews.ac.uk"],
			subject: "Tenancy agreement",
			body: "Hi all, attached is the signed agreement for 14 Cotham Grove. Welcome!\n\nJames",
			receivedAt: hoursAgo(24 * 74),
			category: "LANDLORD",
			conversation: ids.cothamConversation,
			read: true,
			attachments: [file("Tenancy-agreement.pdf", "My home › Contract")]
		}),
		maya("dps", {
			from: "noreply@depositprotection.com",
			fromName: "Deposit Protection Service",
			subject: "Your deposit is protected",
			body: "Your deposit of £801 for 14 Cotham Grove is protected. Reference DPS-7781-2209.\n\nYour certificate is attached. Keep it until the end of your tenancy.",
			receivedAt: hoursAgo(26),
			category: "DEPOSIT",
			counterpartName: "Deposit Protection Service",
			read: true,
			attachments: [file("DPS-certificate.pdf", "My home › Deposit")]
		}),
		maya("octopus", {
			from: "hello@octopus.energy",
			fromName: "Octopus Energy",
			subject: `Your ${lastMonth} statement`,
			body: `Your ${lastMonth} statement for 14 Cotham Grove is ready. Usage: 312 kWh.\n\nTotal: £214.00 (paid by your landlord, bills are included in your rent).`,
			receivedAt: hoursAgo(50),
			category: "BILLS",
			read: true,
			attachments: [file(`Statement-${lastMonth.slice(0, 3)}.pdf`, "My home › Bills")]
		}),
		maya("uni-council-tax", {
			from: "studentservices@bristol.ac.uk",
			fromName: "University of Bristol Student Services",
			subject: `Council tax exemption certificate ${years}`,
			body: `Dear Maya,\n\nAttached is your council tax exemption certificate for ${years}. Send it to your council if they ask for it.\n\nStudent Services`,
			receivedAt: hoursAgo(24 * 4),
			category: "UNIVERSITY",
			counterpartName: "University of Bristol",
			read: true,
			attachments: [file("Council-tax-exemption.pdf", "My home › Documents")]
		}),
		james("tenant-boiler", {
			thread: "tenant-boiler",
			from: mayaAddress,
			fromName: "Maya Rahman",
			subject: "Re: Boiler",
			body: "Tuesday 9–11am works, someone will be in. Thanks!\n\nMaya",
			receivedAt: hoursAgo(1),
			category: "TENANT",
			conversation: ids.cothamConversation
		}),
		james("dps-landlord", {
			from: "noreply@depositprotection.com",
			fromName: "Deposit Protection Service",
			subject: "Deposit protection certificate",
			body: "The deposit of £801 for 14 Cotham Grove is protected. Reference DPS-7781-2209.\n\nThe deposit protection certificate is attached. Give your tenants a copy and the prescribed information within 30 days.",
			receivedAt: hoursAgo(26),
			category: "DEPOSIT",
			counterpartName: "Deposit Protection Service",
			attachments: [file("DPS-certificate.pdf", "14 Cotham Grove › Deposit")]
		})
	];

	return {
		connections: [connection(ids.mayaMailbox, ids.student, mayaAddress), connection(ids.jamesMailbox, ids.james, jamesAddress)],
		messages
	};
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

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "mongo"]);

/**
 * These commands wipe collections and create a superuser, so they must never
 * run against a shared database. The check is on the connection target rather
 * than on NODE_ENV alone, because the destructive case is a developer whose
 * .env points somewhere real.
 */
function assertLocalTarget(uri) {
	if (process.env.ALLOW_REMOTE_DB_SCRIPTS === "true") {
		console.warn("ALLOW_REMOTE_DB_SCRIPTS is set — skipping the local-target check.");
		return;
	}

	let hosts;
	try {
		// mongodb+srv and comma-separated seed lists both parse through the URL
		// class once the scheme is normalised.
		const normalised = uri.replace(/^mongodb(\+srv)?:\/\//, "http://");
		hosts = new URL(normalised).host
			.split(",")
			.map(host => host.split(":")[0].trim().toLowerCase())
			.filter(Boolean);
	} catch {
		throw new Error(`Could not parse MONGODB_URI, refusing to continue.`);
	}

	const remote = hosts.filter(host => !LOCAL_HOSTS.has(host));
	if (remote.length > 0) {
		throw new Error(
			`Refusing to run against non-local database host(s): ${remote.join(", ")}. ` +
			"These commands delete every collection and create a superuser. " +
			"Set ALLOW_REMOTE_DB_SCRIPTS=true only if you are certain."
		);
	}
}

async function main() {
	loadEnv();

	const command = process.argv[2] || "seed";
	const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/seek";

	if (command !== "indexes") {
		assertLocalTarget(uri);
	}

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
