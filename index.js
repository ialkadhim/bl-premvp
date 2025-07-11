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

// Middleware to check admin authentication
const authenticateAdmin = async (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  
  try {
    // In a real app, you'd verify JWT tokens
    // For now, we'll use a simple session approach
    const result = await pool.query(
      'SELECT a.*, ac.name as academy_name, ac.details as academy_details FROM admins a JOIN academies ac ON a.academy_id = ac.id WHERE a.session_token = $1',
      [token]
    );
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }
    
    req.admin = result.rows[0];
    next();
  } catch (err) {
    console.error('Auth error:', err);
    res.status(500).json({ error: 'Authentication failed' });
  }
};

// Admin login endpoint
app.post('/api/admin/login', async (req, res) => {
  const { username, password, stayLoggedIn } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  
  try {
    const result = await pool.query(
      `SELECT a.*, ac.name as academy_name, ac.details as academy_details 
       FROM admins a 
       JOIN academies ac ON a.academy_id = ac.id 
       WHERE a.user_name = $1 AND a.passkey = $2`,
      [username, password]
    );
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const admin = result.rows[0];
    
    // Generate session token (in production, use JWT)
    const sessionToken = Math.random().toString(36).substring(2) + Date.now().toString(36);
    
    // Store session token in database
    await pool.query(
      'UPDATE admins SET session_token = $1, last_login = NOW() WHERE id = $2',
      [sessionToken, admin.id]
    );
    
    res.json({
      token: sessionToken,
      admin: {
        id: admin.id,
        username: admin.user_name,
        academy_id: admin.academy_id,
        academy_name: admin.academy_name,
        academy_details: admin.academy_details
      },
      stayLoggedIn: stayLoggedIn || false
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Admin logout endpoint
app.post('/api/admin/logout', authenticateAdmin, async (req, res) => {
  try {
    await pool.query(
      'UPDATE admins SET session_token = NULL WHERE id = $1',
      [req.admin.id]
    );
    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    console.error('Logout error:', err);
    res.status(500).json({ error: 'Logout failed' });
  }
});

// Get current admin session
app.get('/api/admin/session', authenticateAdmin, async (req, res) => {
  res.json({
    admin: {
      id: req.admin.id,
      username: req.admin.user_name,
      academy_id: req.admin.academy_id,
      academy_name: req.admin.academy_name,
      academy_details: req.admin.academy_details
    }
  });
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

// Admin: Get all events for the authenticated admin's academy
app.get('/api/events', authenticateAdmin, async (req, res) => {
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
        e.guided_by,
        e.academy_id,
        (SELECT COUNT(*) FROM registrations r WHERE r.event_id = e.id AND r.status = 'confirmed') AS spots_filled,
        (SELECT COUNT(*) FROM registrations r2 WHERE r2.event_id = e.id AND r2.status = 'waitlist') AS waitlist_count
      FROM events e
      WHERE e.academy_id = $1
      ORDER BY e.start_time ASC
    `, [req.admin.academy_id]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error retrieving all events');
  }
});

// Create a new event (New Booking)
app.post('/api/events', authenticateAdmin, async (req, res) => {
  const {
    title,
    start_time,
    end_time,
    day,
    event_date,
    level_required,
    level,
    capacity,
    description,
    type,
    cust_group,
    venue,
    guided_by
  } = req.body;

  console.log('DEBUG: Received event body:', req.body);

  // Ensure event_date is set
  let safeEventDate = event_date;
  if (!safeEventDate || safeEventDate === '') {
    if (start_time && typeof start_time === 'string' && start_time.length >= 10) {
      safeEventDate = start_time.slice(0, 10);
    } else {
      return res.status(400).json({ error: 'event_date is required and could not be determined from start_time.' });
    }
  }

  if (!title || !start_time || !end_time || !capacity || !type || !venue || !safeEventDate) {
    return res.status(400).json({ error: 'Missing required event fields' });
  }

  try {
    const params = [title, start_time, end_time, day, safeEventDate, level_required, level, capacity, description, type, cust_group, venue, guided_by, req.admin.academy_id];
    console.log('DEBUG: Insert params:', params);
    const result = await pool.query(
      `INSERT INTO events (title, start_time, end_time, day, event_date, level_required, level, capacity, description, type, cust_group, venue, guided_by, academy_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      params
    );
    res.status(201).json({ event: result.rows[0], message: 'Event created successfully' });
  } catch (err) {
    console.error('DEBUG: Failed to create event:', err.stack || err);
    res.status(500).json({ error: 'Failed to create event' });
  }
});

// Update an event by ID
app.put('/api/events/:id', authenticateAdmin, async (req, res) => {
  const eventId = req.params.id;
  const {
    title,
    start_time,
    end_time,
    day,
    event_date,
    level_required,
    level,
    capacity,
    description,
    type,
    cust_group,
    venue,
    guided_by
  } = req.body;

  // Ensure event_date is set
  let safeEventDate = event_date;
  if (!safeEventDate || safeEventDate === '') {
    if (start_time && typeof start_time === 'string' && start_time.length >= 10) {
      safeEventDate = start_time.slice(0, 10);
    } else {
      return res.status(400).json({ error: 'event_date is required and could not be determined from start_time.' });
    }
  }

  if (!title || !start_time || !end_time || !capacity || !type || !venue || !safeEventDate) {
    return res.status(400).json({ error: 'Missing required event fields' });
  }

  try {
    const params = [title, start_time, end_time, day, safeEventDate, level_required, level, capacity, description, type, cust_group, venue, guided_by, eventId, req.admin.academy_id];
    const result = await pool.query(
      `UPDATE events SET
        title = $1,
        start_time = $2,
        end_time = $3,
        day = $4,
        event_date = $5,
        level_required = $6,
        level = $7,
        capacity = $8,
        description = $9,
        type = $10,
        cust_group = $11,
        venue = $12,
        guided_by = $13
      WHERE id = $14 AND academy_id = $15
      RETURNING *`,
      params
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.json({ event: result.rows[0], message: 'Event updated successfully' });
  } catch (err) {
    console.error('DEBUG: Failed to update event:', err.stack || err);
    res.status(500).json({ error: 'Failed to update event' });
  }
});

// sorting of events
// ✅ /api/events/:userId with level, gender (cust_group), waitlist count, and description

// --- USER AUTHENTICATION (user_login table) ---

// Middleware to check user authentication
const authenticateUser = async (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const result = await pool.query(
      `SELECT ul.*, u.* FROM user_login ul JOIN users u ON ul.user_id = u.id WHERE ul.session_token = $1`,
      [token]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }
    req.user = result.rows[0];
    next();
  } catch (err) {
    console.error('User auth error:', err);
    res.status(500).json({ error: 'Authentication failed' });
  }
};

// User login endpoint (user_login table)
app.post('/api/user/login', async (req, res) => {
  const { user_name, passkey } = req.body;
  if (!user_name || !passkey) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  try {
    const result = await pool.query(
      `SELECT * FROM user_login WHERE user_name = $1 AND passkey = $2`,
      [user_name, passkey]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const login = result.rows[0];
    // Check if user_id is null (account not activated)
    if (login.user_id === null) {
      return res.status(403).json({ error: 'Your account is not yet activated. Please check back later.' });
    }
    // Generate session token
    const sessionToken = Math.random().toString(36).substring(2) + Date.now().toString(36);
    // Store session token and update last_login
    await pool.query(
      'UPDATE user_login SET session_token = $1, last_login = NOW() WHERE id = $2',
      [sessionToken, login.id]
    );
    // Fetch user profile
    const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [login.user_id]);
    const user = userRes.rows[0];
    res.json({
      token: sessionToken,
      user: {
        id: user.id,
        full_name: user.full_name,
        last_name: user.last_name,
        membership_number: user.membership_number,
        gender: user.gender,
        tennis_competency_level: user.tennis_competency_level,
        level: user.level, // <-- Add this line to include the float level
        status: user.status
      }
    });
  } catch (err) {
    console.error('User login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// User logout endpoint
app.post('/api/user/logout', authenticateUser, async (req, res) => {
  try {
    await pool.query('UPDATE user_login SET session_token = NULL WHERE id = $1', [req.user.id]);
    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    console.error('User logout error:', err);
    res.status(500).json({ error: 'Logout failed' });
  }
});

// Get current user session
app.get('/api/user/session', authenticateUser, async (req, res) => {
  res.json({
    user: {
      id: req.user.user_id,
      full_name: req.user.full_name,
      last_name: req.user.last_name,
      membership_number: req.user.membership_number,
      gender: req.user.gender,
      tennis_competency_level: req.user.tennis_competency_level,
      status: req.user.status
    }
  });
});

// User: Create a new event (Publish Event)
app.post('/api/user/events', authenticateUser, async (req, res) => {
  const {
    academy_id,
    title,
    type,
    start_time,
    end_time,
    venue,
    capacity,
    level_required,
    level,
    cust_group,
    description
  } = req.body;

  console.log('DEBUG: User event creation - Received body:', req.body);

  // Validate required fields
  if (!academy_id || !title || !type || !start_time || !end_time || !venue || !capacity) {
    return res.status(400).json({ error: 'Missing required event fields' });
  }

  try {
    // Verify user has membership at this academy
    const membershipCheck = await pool.query(
      `SELECT * FROM academy_memberships 
       WHERE player_id = $1 AND academy_id = $2 AND (expiry_date IS NULL OR expiry_date > NOW())`,
      [req.user.user_id, academy_id]
    );

    if (membershipCheck.rows.length === 0) {
      return res.status(403).json({ error: 'You do not have an active membership at this academy' });
    }

    // Parse the date and time
    const startDate = new Date(start_time);
    const endDate = new Date(end_time);
    
    // Extract date components
    const eventDate = startDate.toISOString().split('T')[0]; // YYYY-MM-DD format
    
    // Get day name from the date
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const day = dayNames[startDate.getDay()];
    
    // Format timestamps for database (YYYY-MM-DD HH:MM:SS)
    const formattedStartTime = startDate.toISOString().slice(0, 19).replace('T', ' ');
    const formattedEndTime = endDate.toISOString().slice(0, 19).replace('T', ' ');
    
    // Use user's full name as guided_by (default)
    const guidedBy = req.user.full_name || 'User Created';

    console.log('DEBUG: User event creation - Processed data:', {
      eventDate,
      day,
      formattedStartTime,
      formattedEndTime,
      guidedBy
    });

    // --- Level logic ---
    // REMOVE the following block:
    // let level_required = 'All Levels';
    // let level = null;
    // if (level_required === 'my-level') {
    //   ...
    // }
    // Instead, use the destructured values from req.body as-is.

    const params = [
      title,
      formattedStartTime,
      formattedEndTime,
      day,
      eventDate,
      level_required,
      level,
      capacity,
      description || null,
      type,
      cust_group,
      venue,
      guidedBy,
      academy_id
    ];

    console.log('DEBUG: User event creation - Insert params:', params);

    const result = await pool.query(
      `INSERT INTO events (title, start_time, end_time, day, event_date, level_required, level, capacity, description, type, cust_group, venue, guided_by, academy_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      params
    );

    const createdEvent = result.rows[0];
    
    // Format the response to match frontend expectations
    const responseEvent = {
      id: createdEvent.id,
      title: createdEvent.title,
      start_time: createdEvent.start_time,
      end_time: createdEvent.end_time,
      day: createdEvent.day,
      event_date: createdEvent.event_date,
      level_required: createdEvent.level_required,
      capacity: createdEvent.capacity,
      description: createdEvent.description,
      type: createdEvent.type,
      cust_group: createdEvent.cust_group,
      venue: createdEvent.venue,
      guided_by: createdEvent.guided_by,
      academy_id: createdEvent.academy_id,
      spots_filled: 0, // New event, no participants yet
      waitlist_count: 0,
      user_status: null
    };

    res.status(201).json({ 
      event: responseEvent, 
      message: 'Event published successfully',
      event_id: createdEvent.id
    });

  } catch (err) {
    console.error('DEBUG: User event creation failed:', err.stack || err);
    res.status(500).json({ error: 'Failed to publish event' });
  }
});

// --- ACADEMY MEMBERSHIPS ENDPOINT ---
// Returns all active memberships (not expired) for a user
app.get('/api/user/:userId/memberships', authenticateUser, async (req, res) => {
  const userId = req.params.userId;
  try {
    const result = await pool.query(
      `SELECT * FROM academy_memberships WHERE player_id = $1 AND (expiry_date IS NULL OR expiry_date > NOW())`,
      [userId]
    );
    res.json({ memberships: result.rows });
  } catch (err) {
    console.error('Memberships fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch memberships' });
  }
});

app.get('/api/events/:userId', authenticateUser, async (req, res) => {
  const userId = req.params.userId;

  try {
    // Get user's active academy memberships
    const membershipsRes = await pool.query(
      `SELECT academy_id FROM academy_memberships WHERE player_id = $1 AND (expiry_date IS NULL OR expiry_date > NOW())`,
      [userId]
    );
    const academyIds = membershipsRes.rows.map(r => r.academy_id);
    if (!academyIds.length) {
      return res.json([]); // No memberships, no events
    }

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

    // Calculate the level range in JavaScript
    const minLevel = userLevelNum - 1.0;
    const maxLevel = userLevelNum + 0.5;
    
    console.log('DEBUG - Level range:', { userLevel: userLevelNum, minLevel, maxLevel });

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
          e.guided_by,
          COUNT(DISTINCT r.user_id) FILTER (WHERE r.status = 'confirmed') AS spots_filled,
          COUNT(DISTINCT r2.user_id) FILTER (WHERE r2.status = 'waitlist') AS waitlist_count,
          MAX(ur.status) AS user_status,
          ur.completion AS completion
        FROM events e
        LEFT JOIN registrations r ON r.event_id = e.id
        LEFT JOIN registrations r2 ON r2.event_id = e.id
        LEFT JOIN registrations ur ON ur.event_id = e.id AND ur.user_id = $1
        WHERE (
          e.academy_id = ANY($2::int[])
          AND (
          e.level_required = 'All Levels' 
            OR (e.level >= $3 AND e.level <= $4)
        )
          AND (e.cust_group = 'Mix Adult' OR e.cust_group = $5)
        )
        GROUP BY e.id, ur.completion
        ORDER BY e.start_time ASC
      `, [userId, academyIds, minLevel, maxLevel, userGender]);

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

// ✅ /api/event/:eventId/waitlist returns waitlist participant full names
app.get('/api/event/:eventId/waitlist', async (req, res) => {
  const eventId = req.params.eventId;

  try {
    const result = await pool.query(`
      SELECT u.full_name FROM registrations r
      JOIN users u ON u.id = r.user_id
      WHERE r.event_id = $1 AND r.status = 'waitlist'
    `, [eventId]);

    const names = result.rows.map(row => row.full_name);
    res.json({ waitlist: names });
  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to load waitlist');
  }
});

// Admin: Get active users count for the academy
app.get('/api/users/active/count', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT COUNT(*) as count 
      FROM users 
      WHERE status = 'Active'
    `);
    res.json({ count: parseInt(result.rows[0].count) });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error retrieving active users count');
  }
});

// User-specific: Get active users count (fallback)
app.get('/api/users/:userId/active/count', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT COUNT(*) as count 
      FROM users 
      WHERE status = 'Active'
    `);
    res.json({ count: parseInt(result.rows[0].count) });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error retrieving active users count');
  }
});

// Admin: Get confirmed registrations count for current week for the academy
app.get('/api/registrations/confirmed/week', authenticateAdmin, async (req, res) => {
  try {
    // Get current week (Sunday to Saturday)
    const today = new Date();
    const dayOfWeek = today.getDay(); // 0 (Sun) - 6 (Sat)
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - dayOfWeek); // Sunday
    weekStart.setHours(0, 0, 0, 0);
    
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6); // Saturday
    weekEnd.setHours(23, 59, 59, 999);

    const result = await pool.query(`
      SELECT COUNT(*) as count 
      FROM registrations r
      JOIN events e ON e.id = r.event_id
      WHERE r.status = 'confirmed' 
        AND e.start_time >= $1 
        AND e.start_time <= $2
        AND e.academy_id = $3
    `, [weekStart.toISOString(), weekEnd.toISOString(), req.admin.academy_id]);
    
    res.json({ count: parseInt(result.rows[0].count) });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error retrieving confirmed registrations count');
  }
});

// User-specific: Get confirmed registrations count for current week (fallback)
app.get('/api/registrations/:userId/confirmed/week', async (req, res) => {
  try {
    // Get current week (Sunday to Saturday)
    const today = new Date();
    const dayOfWeek = today.getDay(); // 0 (Sun) - 6 (Sat)
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - dayOfWeek); // Sunday
    weekStart.setHours(0, 0, 0, 0);
    
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6); // Saturday
    weekEnd.setHours(23, 59, 59, 999);

    const result = await pool.query(`
      SELECT COUNT(*) as count 
      FROM registrations r
      JOIN events e ON e.id = r.event_id
      WHERE r.status = 'confirmed' 
        AND e.start_time >= $1 
        AND e.start_time <= $2
    `, [weekStart.toISOString(), weekEnd.toISOString()]);
    
    res.json({ count: parseInt(result.rows[0].count) });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error retrieving confirmed registrations count');
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

// Registration survey endpoint
app.post('/api/register-survey', async (req, res) => {
  const { full_name, phone, email, type, subscription, club_name, city } = req.body;
  // Only require club_name for Academy
  if (!full_name || !phone || !email || !type || !subscription || !city || (type === 'Academy' && !club_name)) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  try {
    await pool.query(
      `INSERT INTO register_survey (full_name, phone, email, type, subscription, club_name, city)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [full_name, phone, email, type, subscription, club_name || null, city]
    );
    res.status(201).json({ message: 'Registration received' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save registration' });
  }
});

// Admin: Get all users for the academy
app.get('/api/users', authenticateAdmin, async (req, res) => {
  try {
    console.log('DEBUG: /api/users called with admin:', {
      id: req.admin.id,
      academy_id: req.admin.academy_id,
      academy_name: req.admin.academy_name
    });

    const result = await pool.query(`
      SELECT id, full_name, email, level, gender, status
      FROM users 
      ORDER BY full_name
    `);

    console.log('DEBUG: Found', result.rows.length, 'users globally');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    console.error('DEBUG: Full error details:', {
      message: err.message,
      code: err.code,
      detail: err.detail,
      hint: err.hint
    });
    res.status(500).send('Error retrieving users');
  }
});

// Fallback: Get all users (no authentication required)
app.get('/api/users/fallback', async (req, res) => {
  try {
    console.log('DEBUG: /api/users/fallback called');
    const result = await pool.query(`
      SELECT id, full_name, email, level, gender, status
      FROM users 
      ORDER BY full_name
    `);
    console.log('DEBUG: Found', result.rows.length, 'users total');
    res.json(result.rows);
  } catch (err) {
    console.error('DEBUG: Fallback users error:', err);
    res.status(500).send('Error retrieving users');
  }
});

// Get all academies (for frontend dropdown population)
app.get('/api/academies', async (req, res) => {
  try {
    console.log('DEBUG: /api/academies called');
    const result = await pool.query(`
      SELECT id, name, details
      FROM academies 
      ORDER BY name
    `);
    console.log('DEBUG: Found', result.rows.length, 'academies');
    res.json(result.rows);
  } catch (err) {
    console.error('DEBUG: Academies error:', err);
    res.status(500).send('Error retrieving academies');
  }
});

// --- USER SIGNUP ENDPOINT ---
app.post('/api/user/signup', async (req, res) => {
  const { username, password, lastname, firstname, gender, phone, email } = req.body;
  if (!username || !password || !lastname || !firstname || !gender || !phone || !email) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  try {
    // Check for existing user_name, phone, email
    const [userNameRes, phoneRes, emailRes] = await Promise.all([
      pool.query('SELECT 1 FROM user_login WHERE user_name = $1', [username]),
      pool.query('SELECT 1 FROM users WHERE phone = $1', [phone]),
      pool.query('SELECT 1 FROM users WHERE email = $1', [email])
    ]);
    const errors = {};
    if (userNameRes.rows.length > 0) errors.username = 'This username is already taken.';
    if (phoneRes.rows.length > 0) errors.phone = 'This phone number is already used.';
    if (emailRes.rows.length > 0) errors.email = 'This email address is already used.';
    if (Object.keys(errors).length > 0) {
      return res.status(409).json({ errors });
    }

    // Create user_login record (user_name, passkey)
    const userLoginResult = await pool.query(
      'INSERT INTO user_login (user_name, passkey) VALUES ($1, $2) RETURNING id',
      [username, password]
    );
    const userLoginId = userLoginResult.rows[0].id;

    // Create users record
    const fullName = firstname + ' ' + lastname;
    const usersResult = await pool.query(
      'INSERT INTO users (last_name, full_name, gender, phone, email, membership_number) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [lastname, fullName, gender, phone, email, username]
    );
    const userId = usersResult.rows[0].id;

    // Optionally, link user_login.user_id to users.id (if schema allows)
    await pool.query('UPDATE user_login SET user_id = $1 WHERE id = $2', [userId, userLoginId]);

    res.status(201).json({ message: 'Signup successful. Account pending activation.' });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Signup failed. Please try again.' });
  }
});

// --- LEADERBOARD: Top 3 users by completed events + current user ---
app.get('/api/leaderboard/completed', async (req, res) => {
  try {
    const { user_id } = req.query;
    // Get top 3 users by completed events (status = 'confirmed' AND completion = 'Completed')
    const topUsers = await pool.query(`
      SELECT u.id, u.full_name, COUNT(r.id) FILTER (WHERE r.status = 'confirmed' AND r.completion = 'Completed') AS completed_count
      FROM users u
      LEFT JOIN registrations r ON u.id = r.user_id
      GROUP BY u.id, u.full_name
      ORDER BY completed_count DESC, u.full_name ASC
      LIMIT 3
    `);
    let leaderboard = topUsers.rows;
    // If user_id is provided and not in top 3, fetch and add current user
    if (user_id && !leaderboard.some(u => u.id == user_id)) {
      const userRow = await pool.query(`
        SELECT u.id, u.full_name, COUNT(r.id) FILTER (WHERE r.status = 'confirmed' AND r.completion = 'Completed') AS completed_count
        FROM users u
        LEFT JOIN registrations r ON u.id = r.user_id
        WHERE u.id = $1
        GROUP BY u.id, u.full_name
      `, [user_id]);
      if (userRow.rows.length) {
        leaderboard.push(userRow.rows[0]);
      }
    }
    res.json({ leaderboard });
  } catch (err) {
    console.error('Leaderboard error:', err);
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

// --- FEATURED EVENT: promo_events (active only) ---
app.get('/api/promo/featured', async (req, res) => {
  try {
    const now = new Date();
    const nowISO = now.toISOString();
    // Use correct column names: promo_start and promo_end
    const promoRes = await pool.query(`
      SELECT p.*, e.title, e.start_time AS event_start_time, e.end_time AS event_end_time, e.venue, e.description
      FROM promo_events p
      JOIN events e ON p.event_id = e.id
      WHERE p.promo_start <= $1 AND p.promo_end >= $1
      ORDER BY p.promo_start DESC
      LIMIT 1
    `, [nowISO]);
    if (!promoRes.rows.length) {
      return res.json({ featured: null });
    }
    res.json({ featured: promoRes.rows[0] });
  } catch (err) {
    console.error('Featured event error:', err);
    res.status(500).json({ error: 'Failed to fetch featured event' });
  }
});

// --- COMPLETED LESSONS COUNT FOR USER ---
app.get('/api/user/:id/completed-lessons', async (req, res) => {
  try {
    const userId = req.params.id;
    // Count registrations where completion = 'Completed'
    const countRes = await pool.query(`
      SELECT COUNT(*) as count
      FROM registrations
      WHERE user_id = $1 AND completion = 'Completed'
    `, [userId]);
    
    res.json({ count: parseInt(countRes.rows[0].count) });
  } catch (err) {
    console.error('Completed lessons count error:', err);
    res.status(500).json({ error: 'Failed to fetch completed lessons count' });
  }
});

// --- NEXT UPCOMING CONFIRMED EVENT FOR USER ---
app.get('/api/user/:id/next-event', async (req, res) => {
  try {
    const userId = req.params.id;
    const now = new Date();
    const nowISO = now.toISOString();
    // Find next event where user is registered (completion is null), ordered by soonest start_time
    const nextRes = await pool.query(`
      SELECT e.*
      FROM registrations r
      JOIN events e ON r.event_id = e.id
      WHERE r.user_id = $1 AND r.completion IS NULL AND e.start_time > $2
      ORDER BY e.start_time ASC
      LIMIT 1
    `, [userId, nowISO]);
    if (!nextRes.rows.length) {
      return res.json({ next: null });
    }
    res.json({ next: nextRes.rows[0] });
  } catch (err) {
    console.error('Next event error:', err);
    res.status(500).json({ error: 'Failed to fetch next event' });
  }
});

const PORT = process.env.PORT || 3000;
console.log('🧪 DEBUG ENVIRONMENT PORT:', PORT);
app.listen(PORT, () => console.log(`✅ Server is running on port ${PORT}`));
