import { Timestamp, GeoPoint, DocumentReference } from "firebase-admin/firestore";

const FORMAT = "firestore-recursive-backup";
const VERSION = 1;
const TYPE_KEY = "$firestoreBackup";

function encodeValue(value) {
    if (value === null || value === undefined) {
        return value;
    }

    if (value instanceof Timestamp) {
        return { [TYPE_KEY]: "timestamp", value: value.toDate().toISOString() };
    }

    if (value instanceof GeoPoint) {
        return { [TYPE_KEY]: "geopoint", latitude: value.latitude, longitude: value.longitude };
    }

    if (value instanceof DocumentReference) {
        return { [TYPE_KEY]: "reference", path: value.path };
    }

    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
        return { [TYPE_KEY]: "bytes", value: Buffer.from(value).toString("base64") };
    }

    if (typeof value === "number" && !Number.isFinite(value)) {
        return { [TYPE_KEY]: "number", value: String(value) };
    }

    if (Array.isArray(value)) {
        return value.map(encodeValue);
    }

    if (value instanceof Date) {
        return { [TYPE_KEY]: "timestamp", value: value.toISOString() };
    }

    if (typeof value === "object") {
        const entries = Object.fromEntries(
            Object.entries(value).map(([key, item]) => [key, encodeValue(item)])
        );

        // Escape user objects containing our reserved marker key, so their
        // original data can never be mistaken for a Firestore type.
        if (Object.prototype.hasOwnProperty.call(value, TYPE_KEY)) {
            return { [TYPE_KEY]: "object", value: entries };
        }

        return entries;
    }

    return value;
}

async function exportDocument(snapshot, statistics) {
    const collections = await snapshot.ref.listCollections();
    collections.sort((a, b) => a.id.localeCompare(b.id));

    const exportedCollections = [];

    for (const collectionRef of collections) {
        const collectionSnapshot = await collectionRef.get();
        const documents = [];

        for (const documentSnapshot of collectionSnapshot.docs) {
            documents.push(await exportDocument(documentSnapshot, statistics));
        }

        documents.sort((a, b) => a.id.localeCompare(b.id));

        exportedCollections.push({
            name: collectionRef.id,
            documents
        });

        statistics.collections += 1;
    }

    statistics.documents += 1;

    return {
        id: snapshot.id,
        data: encodeValue(snapshot.data() || {}),
        collections: exportedCollections
    };
}

export async function exportFirestore({ db, rootCollection, projectId, brandId = null }) {
    if (!rootCollection || rootCollection.includes("/")) {
        throw new Error(`Invalid root collection name: ${rootCollection}`);
    }

    const statistics = { documents: 0, collections: 0 };
    const rootRef = db.collection(rootCollection);
    let snapshots;

    if (brandId) {
        const snapshot = await rootRef.doc(brandId).get();

        if (!snapshot.exists) {
            throw new Error(`Brand "${brandId}" does not exist in project "${projectId}".`);
        }

        snapshots = [snapshot];
    } else {
        const result = await rootRef.get();
        snapshots = result.docs;
    }

    snapshots.sort((a, b) => a.id.localeCompare(b.id));

    const brands = [];

    for (const snapshot of snapshots) {
        brands.push(await exportDocument(snapshot, statistics));
    }

    return {
        format: FORMAT,
        version: VERSION,
        exportedAt: new Date().toISOString(),
        sourceProjectId: projectId,
        rootCollection,
        brands,
        statistics
    };
}
