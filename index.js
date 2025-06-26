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

    console.log('DEBUG - User Level (raw):', userLevel, 'Type:', typeof userLevel, 'User Gender:', userGender);

    // Convert userLevel to float8 to match database schema
    const userLevelNum = parseFloat(userLevel);
    console.log('DEBUG - User Level (parsed):', userLevelNum, 'Type:', typeof userLevelNum, 'Is NaN:', isNaN(userLevelNum));

    // Validate the parsed level
    if (isNaN(userLevelNum)) {
      console.error('DEBUG - Invalid user level:', userLevel);
      return res.status(400).json({ error: 'Invalid user level' });
    }

    try {
      const result = await pool.query(`
        SELECT 
          e.id,
          e.title,
          TO_CHAR(e.start_time, 'YYYY-MM-DD"T"HH24:MI:SS') AS start_time,
          TO_CHAR(e.end_time, 'YYYY-MM-DD"T"HH24:MI:SS') AS end_time,
          e.level_required,
          e.level,
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
          OR (e.level >= $2 - 1 AND e.level <= $2 + 0.5)
        )
          AND (e.cust_group = 'Mix Adult' OR e.cust_group = $3)
        GROUP BY e.id
        ORDER BY e.start_time ASC
      `, [userId, userLevelNum, userGender]);

      console.log('DEBUG - Events found:', result.rows.length);
      console.log('DEBUG - Event levels:', result.rows.map(e => ({ id: e.id, title: e.title, level: e.level, level_required: e.level_required })));

      res.json(result.rows);
    } catch (queryError) {
      console.error('DEBUG - Query error details:', queryError);
      console.error('DEBUG - User ID:', userId, 'User Level:', userLevelNum, 'User Gender:', userGender);
      throw queryError;
    }
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
      SELECT u.full_name FROM registrations r
      JOIN users u ON u.id = r.user_id
      WHERE r.event_id = $1 AND r.status = 'confirmed'
    `, [eventId]);

    const names = result.rows.map(row => row.full_name);
    res.json({ participants: names });
  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to load participants');
  }
});


//event registration with atomic transactions and capacity enforcement
app.post('/api/register', async (req, res) => {
  const { userId, eventId, status } = req.body;

  if (!userId || !eventId || !status) {
    return res.status(400).json({ error: 'Missing registration details' });
  }

  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    if (status === 'withdrawn') {
      // Handle withdrawal with atomic transaction
      await client.query(
        'UPDATE registrations SET status = $1 WHERE user_id = $2 AND event_id = $3',
        ['withdrawn', userId, eventId]
      );

      // Get current confirmed count and capacity
      const eventResult = await client.query(
        'SELECT capacity FROM events WHERE id = $1',
        [eventId]
      );
      
      if (eventResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Event not found' });
      }

      const capacity = eventResult.rows[0].capacity;
      
      // Count current confirmed registrations
      const confirmedCount = await client.query(
        'SELECT COUNT(*) FROM registrations WHERE event_id = $1 AND status = $2',
        [eventId, 'confirmed']
      );
      
      const currentConfirmed = parseInt(confirmedCount.rows[0].count);

      // If there's space available, promote from waitlist
      if (currentConfirmed < capacity) {
        const waitlisted = await client.query(
          'SELECT user_id FROM registrations WHERE event_id = $1 AND status = $2 ORDER BY created_at ASC LIMIT 1',
          [eventId, 'waitlist']
        );

        if (waitlisted.rows.length > 0) {
          const nextUserId = waitlisted.rows[0].user_id;
          await client.query(
            'UPDATE registrations SET status = $1 WHERE user_id = $2 AND event_id = $3',
            ['confirmed', nextUserId, eventId]
          );
        }
      }

      await client.query('COMMIT');
      return res.sendStatus(204);
    }

    // Handle registration (confirmed or waitlist)
    console.log('REGISTRATION:', { userId, eventId, status });

    // Get event with FOR UPDATE lock to prevent race conditions
    const eventResult = await client.query(
      'SELECT capacity FROM events WHERE id = $1 FOR UPDATE',
      [eventId]
    );

    if (eventResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Event not found' });
    }

    const capacity = eventResult.rows[0].capacity;

    // Count current confirmed registrations
    const confirmedCount = await client.query(
      'SELECT COUNT(*) FROM registrations WHERE event_id = $1 AND status = $2',
      [eventId, 'confirmed']
    );
    
    const currentConfirmed = parseInt(confirmedCount.rows[0].count);

    // Check if user is already registered
    const existingRegistration = await client.query(
      'SELECT status FROM registrations WHERE user_id = $1 AND event_id = $2',
      [userId, eventId]
    );

    let finalStatus = status;

    // If trying to register as confirmed but event is full
    if (status === 'confirmed' && currentConfirmed >= capacity) {
      if (existingRegistration.rows.length === 0) {
        // New registration - put on waitlist
        finalStatus = 'waitlist';
      } else {
        // Existing registration - keep current status
        finalStatus = existingRegistration.rows[0].status;
      }
    }

    // Insert or update registration
    await client.query(
      `
      INSERT INTO registrations (user_id, event_id, status)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, event_id)
      DO UPDATE SET status = EXCLUDED.status
      `,
      [userId, eventId, finalStatus]
    );

    await client.query('COMMIT');

    // Return appropriate response
    if (status === 'confirmed' && finalStatus === 'waitlist') {
      res.status(409).json({ 
        message: 'Event is full. You have been added to the waitlist.',
        status: 'waitlist'
      });
    } else {
      res.json({ 
        message: 'Registration updated',
        status: finalStatus
      });
    }

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Failed to update registration' });
  } finally {
    client.release();
  }
});

const PORT = process.env.PORT || 3000;
console.log('🧪 DEBUG ENVIRONMENT PORT:', PORT);
app.listen(PORT, () => console.log(`✅ Server is running on port ${PORT}`));
