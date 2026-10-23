import pg from 'pg';
const pool = new pg.Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5432/yet', max: 2 });
try {
  const r = await pool.query(
    `WITH fixes AS (
       SELECT t.idx, t.lat, t.lng
         FROM unnest($1::double precision[], $2::double precision[])
              WITH ORDINALITY AS t(lat, lng, idx)
     )
     SELECT fx.idx, g.geofence_id,
            CASE WHEN g.kind = 'CIRCLE'
                 THEN ST_DWithin(g.geom::geography,
                                 ST_SetSRID(ST_MakePoint(fx.lng, fx.lat), 4326)::geography,
                                 g.radius_m)
                 ELSE ST_Intersects(g.geom, ST_SetSRID(ST_MakePoint(fx.lng, fx.lat), 4326))
            END AS inside
       FROM geofences g
       CROSS JOIN fixes fx
      WHERE g.geofence_id = ANY($3::uuid[]) AND g.active`,
    [[9.03, 9.031], [38.73, 38.732], ['e71ba32b-425e-4389-99a2-d94c6e6c5ca8']]);
  console.log('matrix OK rows=', r.rowCount, JSON.stringify(r.rows));
} catch (e) { console.log('matrix FAIL:', e.message); }
await pool.end();
