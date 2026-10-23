import pg from 'pg';
const pool = new pg.Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5432/yet', max: 2 });
const { rows } = await pool.query(`SELECT vehicle_id, count(*), min(fix_timestamp), max(fix_timestamp) FROM location_fixes GROUP BY vehicle_id`);
console.log('fixes by vehicle:', JSON.stringify(rows, null, 1));
const t = await pool.query(`SELECT trip_id, vehicle_id, started_at, ended_at, state FROM trips ORDER BY started_at DESC LIMIT 6`);
console.log('trips:', JSON.stringify(t.rows, null, 1));
await pool.end();
