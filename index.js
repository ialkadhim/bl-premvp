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


// sorting of events
// ✅ /api/events/:userId with level, gender (cust_group), waitlist count, and description

app.get('/api/events/:userId', async (req, res) => {
  const userId = req.params.userId;

  try {
    const userRes = await pool.query('SELECT level, gender FROM users WHERE id = $1', [userId]);

    if (!userRes.rows.length) {
      return res.status(404).send('User not found');
    }

    const userLevel = userRes.rows[0].level;
    const userGender = userRes.rows[0].gender;

    const result = await pool.query(`
      SELECT 
        e.id,
        e.title,
        TO_CHAR(e.start_time, 'YYYY-MM-DD"T"HH24:MI:SS') AS start_time,
        TO_CHAR(e.end_time, 'YYYY-MM-DD"T"HH24:MI:SS') AS end_time,
        e.level_required,
        e.capacity,
        e.description,
        e.type,
        e.cust_group,
        e.venue,
        COUNT(DISTINCT r.user_id) FILTER (WHERE r.status = 'confirmed') AS spots_filled,
        COUNT(DISTINCT r2.user_id) FILTER (WHERE r2.status = 'waitlist') AS waitlist_count,
        MAX(ur.status) AS user_status
      FROM events e
      LEFT JOIN registrations r ON r.event_id = e.id
      LEFT JOIN registrations r2 ON r2.event_id = e.id
      LEFT JOIN registrations ur ON ur.event_id = e.id AND ur.user_id = $1
      WHERE (
        e.level_required = 'All Levels' 
        OR e.level::int BETWEEN ($2 - 0.5) AND ($2 + 0.5)
      )
        AND (e.cust_group = 'Mix Adult' OR e.cust_group = $3)
      GROUP BY e.id
      ORDER BY e.start_time ASC
    `, [userId, userLevel, userGender]);

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error retrieving events');
  }
});

// ✅ /api/event/:eventId/participants returns confirmed participant last names

app.get('/api/event/:eventId/participants', async (req, res) => {
  const eventId = req.params.eventId;

  try {
    const result = await pool.query(`
      SELECT u.last_name FROM registrations r
      JOIN users u ON u.id = r.user_id
      WHERE r.event_id = $1 AND r.status = 'confirmed'
    `, [eventId]);

    const names = result.rows.map(row => row.last_name);
    res.json({ participants: names });
  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to load participants');
  }
});


//event registration
app.post('/api/register', async (req, res) => {
  const { userId, eventId, status } = req.body;

  if (!userId || !eventId || !status) {
    return res.status(400).json({ error: 'Missing registration details' });
  }

  try {
    if (status === 'withdrawn') {
      // Remove user's registration
      await pool.query('UPDATE registrations SET status = $1 WHERE user_id = $2 AND event_id = $3', ['withdrawn', userId, eventId]);

      // Promote next user from waitlist if any
      const waitlisted = await pool.query(
        'SELECT user_id FROM registrations WHERE event_id = $1 AND status = $2 ORDER BY created_at ASC LIMIT 1',
        [eventId, 'waitlist']
      );

      if (waitlisted.rows.length > 0) {
        const nextUserId = waitlisted.rows[0].user_id;
        await pool.query(
          'UPDATE registrations SET status = $1 WHERE user_id = $2 AND event_id = $3',
          ['confirmed', nextUserId, eventId]
        );
      }

      return res.sendStatus(204);
    }
    
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
