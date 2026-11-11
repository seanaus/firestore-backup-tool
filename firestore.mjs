#!/usr/bin/env node

import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { initializeApp, applicationDefault, getApps } from "firebase-admin/app";
import {
    getFirestore,
    Timestamp,
    GeoPoint,
    DocumentReference
} from "firebase-admin/firestore";

import { exportFirestore } from "./export.mjs";
import { importFirestore } from "./import.mjs";

const command = process.argv[2];
const args = process.argv.slice(3);

const projectId = process.env.FIREBASE_PROJECT_ID || undefined;
const rootCollection = process.env.FIRESTORE_BRAND_COLLECTION || "brand";
const backupFile = path.resolve(
    process.env.FIRESTORE_BACKUP_FILE || "./backups/firestore-export.json"
);

function showUsage() {
    console.log(`
Firestore Backup Tool

Usage:
  node firestore.mjs export [brandId]
  node firestore.mjs import [backupFile] [--dry-run]

Examples:
  node firestore.mjs export
  node firestore.mjs export xde45gth67keu483
  node firestore.mjs import
  node firestore.mjs import ./backups/firestore-export.json
  node firestore.mjs import ./backups/firestore-export.json --dry-run

Environment:
  FIREBASE_PROJECT_ID             Optional destination/source project ID
  GOOGLE_APPLICATION_CREDENTIALS Optional service-account JSON path
  FIRESTORE_BRAND_COLLECTION      Defaults to "brand"
  FIRESTORE_BACKUP_FILE           Defaults to ./backups/firestore-export.json

If GOOGLE_APPLICATION_CREDENTIALS is not set, Application Default Credentials
are used. Run "gcloud auth application-default login" to configure them.
`);
}

function createFirestore() {
    const options = {
        credential: applicationDefault()
    };

    if (projectId) {
        options.projectId = projectId;
    }

    const app = getApps()[0] || initializeApp(options);
    return {
        db: getFirestore(app),
        projectId: app.options.projectId || process.env.GCLOUD_PROJECT || "unknown"
    };
}

async function main() {
    if (!["export", "import"].includes(command)) {
        showUsage();
        process.exitCode = command ? 1 : 0;
        return;
    }

    const connection = createFirestore();
    const db = connection.db;
    const activeProjectId = connection.projectId;

    if (command === "export") {
        const brandId = args.find(arg => !arg.startsWith("--")) || null;
        const backup = await exportFirestore({
            db,
            rootCollection,
            projectId: activeProjectId,
            brandId
        });

        const outputFile = brandId
            ? path.resolve(`./backups/brand-${brandId}.json`)
            : backupFile;

        await mkdir(path.dirname(outputFile), { recursive: true });
        await writeFile(outputFile, JSON.stringify(backup, null, 2), "utf8");

        console.log("\nEXPORT COMPLETE");
        console.log(`Firebase project: ${activeProjectId}`);
        console.log(`Brands exported: ${backup.brands.length}`);
        console.log(`Output file: ${outputFile}`);
        console.log(`Documents exported: ${backup.statistics.documents}`);
        console.log(`Collections discovered: ${backup.statistics.collections}`);
        return;
    }

    const dryRun = args.includes("--dry-run");
    const inputFile = path.resolve(
        args.find(arg => !arg.startsWith("--")) || backupFile
    );

    const raw = await readFile(inputFile, "utf8");
    const backup = JSON.parse(raw);

    await importFirestore({
        db,
        backup,
        destinationProjectId: activeProjectId,
        dryRun,
        types: { Timestamp, GeoPoint, DocumentReference }
    });

    console.log(`\nBackup file: ${inputFile}`);
    console.log(`Destination project: ${activeProjectId}`);
}

main().catch(error => {
    console.error("\nFIRESTORE BACKUP TOOL FAILED");
    console.error(error?.stack || error?.message || error);
    process.exitCode = 1;
});
