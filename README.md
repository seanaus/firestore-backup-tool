# Firestore Backup Tool

Standalone Node.js ESM utility for recursively exporting and importing a Firestore
database organised under a root `brand` collection.

It preserves:
- Every document ID and full document path.
- Collection names and arbitrarily deep subcollection structure.
- Ordinary string IDs and foreign-key fields unchanged.
- Firestore timestamps, GeoPoints, document references and bytes.
- NaN and positive/negative Infinity values.

It does not flatten data, generate replacement IDs, merge brands or overwrite
existing brand documents.

## Requirements

- Node.js 20 or later (Node.js 24 is suitable).
- A Firebase service account with Firestore read/write access, or Google
  Application Default Credentials.
- Access to the source project for export and destination project for import.

## Installation

```bash
npm install
cp .env.example .env
```

Edit `.env`:

```dotenv
FIREBASE_PROJECT_ID=your-firebase-project-id
GOOGLE_APPLICATION_CREDENTIALS=./service-account.json
FIRESTORE_BRAND_COLLECTION=brand
FIRESTORE_BACKUP_FILE=./backups/firestore-export.json
```

`GOOGLE_APPLICATION_CREDENTIALS` is optional if Application Default Credentials
are already configured. Do not commit `.env` or service-account JSON files.

On a machine using Google Cloud CLI, Application Default Credentials can be
configured with:

```bash
gcloud auth application-default login
```

## Export all brands

```bash
node firestore.mjs export
```

Default output:

```text
backups/firestore-export.json
```

## Export one brand

```bash
node firestore.mjs export xde45gth67keu483
```

Output:

```text
backups/brand-xde45gth67keu483.json
```

## Import

Set credentials and `FIREBASE_PROJECT_ID` to the destination Firebase project,
then run:

```bash
node firestore.mjs import
```

Or specify a backup file:

```bash
node firestore.mjs import ./backups/brand-xde45gth67keu483.json
```

## Dry run

Dry run validates the backup and checks every brand ID against the destination.
It does not write any documents.

```bash
node firestore.mjs import ./backups/firestore-export.json --dry-run
```

## Conflict policy

Before writing any documents, the importer:

1. Validates the backup format and version.
2. Checks for duplicate brand IDs inside the backup.
3. Checks every brand ID against the destination `brand` collection.
4. Aborts the entire import if any destination brand document already exists.

It never merges, overwrites, renames or remaps a brand ID.

## Important operational notes

- Firestore does not provide a transaction spanning an entire database import.
  The importer preflights all brand IDs before writing, then writes in batches.
  A network or service failure during the write phase can therefore leave a
  partially imported backup. The error and last completed batch are reported.
- Do not run two imports for the same brand set concurrently. The preflight
  check and subsequent writes are not one atomic operation.
- Keep the backup file secure. It may contain customer, order and other
  sensitive business data.
- Document references are stored as document paths and rebuilt against the
  destination Firestore project. References to documents outside the exported
  brand hierarchy are preserved as paths, but those referenced documents are
  not automatically exported unless they are also inside the exported hierarchy.
- The backup captures documents reachable by recursively listing subcollections
  beneath each existing brand document. It does not discover orphaned
  subcollection documents whose parent document does not exist.
- Firestore document IDs are unique within their collection path, not globally.
  Repeated IDs in different collections are retained as-is.