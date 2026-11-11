const FORMAT = "firestore-recursive-backup";
const VERSION = 1;
const TYPE_KEY = "$firestoreBackup";
const MAX_BATCH_WRITES = 400;

function isPlainObject(value) {
    return value !== null &&
        typeof value === "object" &&
        !Array.isArray(value);
}

function decodeValue(value, db, types) {
    if (value === null || value === undefined) {
        return value;
    }

    if (Array.isArray(value)) {
        return value.map(item => decodeValue(item, db, types));
    }

    if (isPlainObject(value)) {
        if (Object.prototype.hasOwnProperty.call(value, TYPE_KEY)) {
            switch (value[TYPE_KEY]) {
                case "timestamp":
                    return types.Timestamp.fromDate(new Date(value.value));

                case "geopoint":
                    return new types.GeoPoint(value.latitude, value.longitude);

                case "reference":
                    return db.doc(value.path);

                case "bytes":
                    return Buffer.from(value.value, "base64");

                case "number":
                    if (value.value === "NaN") return Number.NaN;
                    if (value.value === "Infinity") return Infinity;
                    if (value.value === "-Infinity") return -Infinity;
                    throw new Error(`Unsupported encoded number: ${value.value}`);

                case "object":
                    return decodeValue(value.value, db, types);

                default:
                    throw new Error(`Unknown Firestore backup type: ${value[TYPE_KEY]}`);
            }
        }

        return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [
                key,
                decodeValue(item, db, types)
            ])
        );
    }

    return value;
}

function validateId(id, description) {
    if (typeof id !== "string" || !id.trim() || id.includes("/")) {
        throw new Error(`Invalid ${description}: ${JSON.stringify(id)}`);
    }
}

function validateAndCollect(backup, db, types) {
    if (!backup || backup.format !== FORMAT) {
        throw new Error("This is not a recognised Firestore backup JSON file.");
    }

    if (backup.version !== VERSION) {
        throw new Error(
            `Unsupported backup version "${backup.version}". This importer supports version ${VERSION}.`
        );
    }

    if (typeof backup.rootCollection !== "string" ||
        !backup.rootCollection.trim() ||
        backup.rootCollection.includes("/")) {
        throw new Error("The backup contains an invalid root collection name.");
    }

    if (!Array.isArray(backup.brands) || backup.brands.length === 0) {
        throw new Error("The backup does not contain any brands.");
    }

    const brandIds = new Set();
    const documentPaths = new Set();
    const records = [];

    function visitDocument(node, documentPath, isBrand = false) {
        if (!node || typeof node !== "object" || Array.isArray(node)) {
            throw new Error(`Invalid document record at "${documentPath}".`);
        }

        validateId(node.id, `document ID at "${documentPath}"`);

        if (documentPaths.has(documentPath)) {
            throw new Error(`Duplicate document path in backup: "${documentPath}".`);
        }
        documentPaths.add(documentPath);

        if (!isPlainObject(node.data)) {
            throw new Error(`Document data must be an object at "${documentPath}".`);
        }

        const data = decodeValue(node.data, db, types);
        records.push({ path: documentPath, data });

        if (node.collections === undefined) {
            node.collections = [];
        }

        if (!Array.isArray(node.collections)) {
            throw new Error(`Invalid subcollection list at "${documentPath}".`);
        }

        for (const collection of node.collections) {
            if (!collection || typeof collection !== "object") {
                throw new Error(`Invalid subcollection at "${documentPath}".`);
            }

            validateId(collection.name, `collection name under "${documentPath}"`);

            if (!Array.isArray(collection.documents)) {
                throw new Error(
                    `Subcollection "${collection.name}" under "${documentPath}" has no documents array.`
                );
            }

            for (const child of collection.documents) {
                validateId(child?.id, `document ID in "${collection.name}"`);
                const childPath = `${documentPath}/${collection.name}/${child.id}`;
                visitDocument(child, childPath, false);
            }
        }
    }

    for (const brand of backup.brands) {
        validateId(brand?.id, "brand ID");

        if (brandIds.has(brand.id)) {
            throw new Error(
                `Duplicate brand ID "${brand.id}" found inside the backup. No data has been imported.`
            );
        }

        brandIds.add(brand.id);
        visitDocument(brand, `${backup.rootCollection}/${brand.id}`, true);
    }

    return { brandIds: [...brandIds], records };
}

export async function importFirestore({
    db,
    backup,
    destinationProjectId,
    dryRun = false,
    types
}) {
    const { brandIds, records } = validateAndCollect(backup, db, types);

    console.log("\nFIRESTORE IMPORT PREFLIGHT");
    console.log(`Destination project: ${destinationProjectId}`);
    console.log(`Root collection: ${backup.rootCollection}`);
    console.log(`Brands in backup: ${brandIds.length}`);
    console.log(`Documents in backup: ${records.length}`);

    // Check every brand before writing a single document.
    const conflicts = [];

    for (const brandId of brandIds) {
        const snapshot = await db
            .collection(backup.rootCollection)
            .doc(brandId)
            .get();

        if (snapshot.exists) {
            const existingName = snapshot.get("name") || "(name unavailable)";
            conflicts.push({ id: brandId, name: existingName });
        }
    }

    if (conflicts.length > 0) {
        console.error("\nIMPORT ABORTED - BRAND ID CONFLICT");
        for (const conflict of conflicts) {
            console.error(`- ${conflict.name}: ${conflict.id}`);
        }
        console.error("\nNo data has been imported.");
        throw new Error(
            `${conflicts.length} brand ID(s) already exist in the destination database.`
        );
    }

    console.log("\nPreflight passed: all brand IDs are unique and available.");

    if (dryRun) {
        console.log("DRY RUN: no data has been written.");
        return;
    }

    let imported = 0;

    for (let offset = 0; offset < records.length; offset += MAX_BATCH_WRITES) {
        const batchRecords = records.slice(offset, offset + MAX_BATCH_WRITES);
        const batch = db.batch();

        for (const record of batchRecords) {
            batch.set(db.doc(record.path), record.data);
        }

        await batch.commit();
        imported += batchRecords.length;

        console.log(`Imported ${imported} of ${records.length} documents...`);
    }

    console.log("\nFIRESTORE IMPORT REPORT");
    console.log(`Destination: ${destinationProjectId}`);
    console.log(`Brands imported: ${brandIds.length}`);
    console.log(`Documents imported: ${imported}`);
    console.log("Status: SUCCESS");
}
