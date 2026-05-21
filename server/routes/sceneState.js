import express from 'express';
import Database from 'better-sqlite3';

export function createSceneStateRouter(dataDir) {
    const router = express.Router();
    const DB_PATH = `${dataDir}/narrativeengine.db`;

    router.get('/campaigns/:id/scene-state', (req, res) => {
        const db = new Database(DB_PATH);
        const row = db.prepare(
            'SELECT * FROM scene_state WHERE campaign_id = ?'
        ).get(req.params.id);
        db.close();
        res.json(row || {
            location: 'Unknown',
            time_of_day: 'Unknown',
            present_npcs: '[]',
            scene_summary: '',
            turn_id: 0
        });
    });

    router.put('/campaigns/:id/scene-state', (req, res) => {
        const db = new Database(DB_PATH);
        const { location, time_of_day, present_npcs, scene_summary, turn_id } = req.body;
        db.prepare(`
            INSERT INTO scene_state 
                (campaign_id, location, time_of_day, present_npcs, 
                 scene_summary, turn_id, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(campaign_id) DO UPDATE SET
                location = excluded.location,
                time_of_day = excluded.time_of_day,
                present_npcs = excluded.present_npcs,
                scene_summary = excluded.scene_summary,
                turn_id = excluded.turn_id,
                updated_at = excluded.updated_at
        `).run(
            req.params.id,
            location,
            time_of_day,
            JSON.stringify(present_npcs || []),
            scene_summary || '',
            turn_id || 0,
            Date.now()
        );
        db.close();
        res.json({ ok: true });
    });

    return router;
}