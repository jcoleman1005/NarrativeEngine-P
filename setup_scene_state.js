import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, 'data', 'narrativeengine.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS scene_state (
    campaign_id TEXT PRIMARY KEY,
    location TEXT NOT NULL DEFAULT 'Unknown',
    time_of_day TEXT NOT NULL DEFAULT 'Unknown',
    present_npcs TEXT NOT NULL DEFAULT '[]',
    scene_summary TEXT NOT NULL DEFAULT '',
    turn_id INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  )
`);

console.log('Done');
db.close();