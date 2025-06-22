require('dotenv').config();
const express = require('express');
const app = express();
const bodyParser = require('body-parser');
const cors = require('cors');
const { Pool } = require('pg');

app.use(cors());
app.use(bodyParser.json());

const pool = new Pool({
  user: process.env.PGUSER,
  host: process.env.PGHOST,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: process.env.PGPORT,
  ssl: { rejectUnauthorized: false }
});

app.get('/api/seed', async (req, res) => {
  await pool.query(`
    INSERT INTO users (last_name, membership_number, full_name, gender, tennis_competency_level, status)
    VALUES ('Park', '12345', 'Subin Park', 'Male', 'Intermediate', 'Active')
    ON CONFLICT (membership_number) DO NOTHING
  `);
  res.json({ message: 'Seeded user' });
});

function mapLevelToCompetency(level) {
  if (level === 0 || level === 0.5) return 'Entry';
  if (level === 1 || level === 1.5) return 'Beginner';
  if (level === 2 || level === 2.5) return 'Intermediate';
  if (level === 3 || level === 3.5) return 'Advanced';
  if (level === 4) return 'Professional';
  return 'Not Specified';
}

app.post('/api/login', async (req, res) => {
  const { lastName, membershipNumber } = req.body;
  const result = await pool.query(
    'SELECT * FROM users WHERE LOWER(last_name) = LOWER($1) AND membership_number = $2',
    [lastName, membershipNumber]
  );
  if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });

  const user = result.rows[0];
  user.tennis_competency_level = mapLevelToCompetency(user.level);
  res.json(user);
});

app.get('/api/events/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    const userRes = await pool.query('SELECT level FROM users WHERE id = $1', [userId]);
    if (userRes.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    const userLevel = userRes.rows[0].level;

    const result = await pool.query(
      `
      SELECT 
        e.*, 
        COUNT(r.status) FILTER (WHERE r.status = 'confirmed') AS spots_filled,
        ur.status AS user_status
      FROM events e
      LEFT JOIN registrations r ON r.event_id = e.id
      LEFT JOIN registrations ur ON ur.event_id = e.id AND ur.user_id = $1
      WHERE 
        e.level IS NULL OR
        ABS(e.level - $2) <= 0.5 OR
        e.level_required = 'All Levels'
      GROUP BY e.id, ur.status
      ORDER BY e.start_time ASC
      `,
      [userId, userLevel]
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

app.post('/api/register', async (req, res) => {
  const { userId, eventId, status } = req.body;

  if (!userId || !eventId || !status) {
    return res.status(400).json({ error: 'Missing registration details' });
  }

  try {
    console.log('REGISTRATION:', { userId, eventId, status });
    await pool.query(
      `
      INSERT INTO registrations (user_id, event_id, status)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, event_id)
      DO UPDATE SET status = EXCLUDED.status
      `,
      [userId, eventId, status]
    );
    res.json({ message: 'Registration updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update registration' });
  }
});

const PORT = process.env.PORT || 3000;
console.log('🧪 DEBUG ENVIRONMENT PORT:', PORT);
app.listen(PORT, () => console.log(`✅ Server is running on port ${PORT}`));