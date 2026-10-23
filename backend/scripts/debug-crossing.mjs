import pg from 'pg';
const pool = new pg.Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5432/yet', max: 2 });
const DAY = 24*3600_000;
const baseMs = Date.now() - 12*DAY;
const { rows: trips } = await pool.query(`SELECT trip_id, started_at, ended_at FROM trips WHERE abs(extract(epoch from started_at - to_timestamp($1/1000.0))) < 5`, [baseMs]);
console.log('trips for control window:', JSON.stringify(trips));
if (trips.length) {
  const t = trips[0];
  const { rows: fixes } = await pool.query(`SELECT fix_timestamp, lat, lng FROM location_fixes WHERE vehicle_id=$1 AND fix_timestamp >= $2 AND fix_timestamp <= $3 ORDER BY fix_timestamp`, [t.vehicle_id ?? (await pool.query('SELECT vehicle_id FROM trips WHERE trip_id=$1',[t.trip_id])).rows[0].vehicle_id, new Date(baseMs-180000).toISOString(), new Date(baseMs+22*60000+60000).toISOString()]);
  console.log('fix count in window:', fixes.length, 'first:', JSON.stringify(fixes[0]), 'last:', JSON.stringify(fixes.at(-1)));
}
const { rows: gf } = await pool.query(`SELECT geofence_id, name, active, ST_AsText(geom) wkt, radius_m FROM geofences ORDER BY created_at DESC LIMIT 3`);
console.log('geofences:', JSON.stringify(gf, null, 1));
await pool.end();
