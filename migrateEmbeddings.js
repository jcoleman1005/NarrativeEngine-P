import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// ─── Setup Paths ───────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// DATA_DIR logic matching server/lib/fileStore.js
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'embeddings.db');

if (!fs.existsSync(DB_PATH)) {
    console.error(`[Error] Database not found at: ${DB_PATH}`);
    console.error(`Please ensure the server has run at least once or DATA_DIR is set correctly.`);
    process.exit(1);
}

// ─── Migration Logic ───────────────────────────────────────────────────────
console.log(`[Migrate] Opening database: ${DB_PATH}`);
const db = new Database(DB_PATH);
sqliteVec.load(db);

function migrateTable(table) {
    console.log(`\n[Migrate] Processing table: ${table}`);

    // Check if table exists
    const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
    if (!tableCheck) {
        console.warn(`[Skip] Table ${table} does not exist.`);
        return;
    }

    // Check if 'scope' column exists via sqlite_master SQL (more reliable for virtual tables)
    const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
    const hasScope = schema && schema.sql.includes('scope');

    if (!hasScope) {
        console.error(`[Error] Table ${table} is missing the 'scope' column.`);
        console.error(`The server's initDb should have added it. Run the server first.`);
        return;
    }

    // Find rows needing update
    const stats = db.prepare(`
        SELECT 
            COUNT(*) as total,
            SUM(CASE WHEN scope IS NULL THEN 1 ELSE 0 END) as nullScope,
            SUM(CASE WHEN scene_id IS NULL THEN 1 ELSE 0 END) as nullSceneId
        FROM ${table}
    `).get();

    console.log(`[Status] Total rows: ${stats.total}`);
    console.log(`[Status] Rows with NULL scope: ${stats.nullScope}`);
    console.log(`[Status] Rows with NULL scene_id: ${stats.nullSceneId}`);

    if (stats.nullScope > 0 || stats.nullSceneId > 0) {
        console.log(`[Action] Updating rows...`);
        const result = db.prepare(`
            UPDATE ${table} 
            SET 
                scope = COALESCE(scope, 'global'),
                scene_id = COALESCE(scene_id, NULL)
            WHERE scope IS NULL OR scene_id IS NULL
        `).run();
        console.log(`[Success] Updated ${result.changes} rows in ${table}.`);
    } else {
        console.log(`[Skip] No rows in ${table} require metadata backfill.`);
    }
}

try {
    db.transaction(() => {
        migrateTable('archive_vss');
        migrateTable('lore_vss');
    })();
    console.log('\n[Finished] Migration completed successfully.');
} catch (err) {
    console.error(`\n[Fatal] Migration failed: ${err.message}`);
    process.exit(1);
} finally {
    db.close();
}
