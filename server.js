require("dotenv").config();

const express = require("express");

const cors = require("cors");

app.use(cors({
  origin: "*", // you can restrict later
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

const { Pool } = require("pg");
const { v4: uuidv4 } = require("uuid");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());

/*
=========================================================
SUPABASE AUTH CLIENT
=========================================================
This client handles authentication only.
It does NOT directly access your Postgres tables.
*/
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

/*
=========================================================
DATABASE CONNECTION (Supabase Postgres via pooler)
=========================================================
Used for your own tables:
- players
- player_stats
- currencies
- etc.
*/
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

/*
=========================================================
HELPER: CREATE PLAYER ROWS AFTER AUTH SIGNUP
=========================================================
We use the Supabase Auth user.id as players.id
*/
async function createPlayerRows(authUserId, username) {
  await pool.query(
    "INSERT INTO players (id, username) VALUES ($1, $2)",
    [authUserId, username]
  );

  await pool.query(
    "INSERT INTO player_stats (player_id) VALUES ($1)",
    [authUserId]
  );
}

/*
=========================================================
HEALTH CHECK
=========================================================
Used to confirm:
- Render is running
- DB connection works
*/
app.get("/ping", async (req, res) => {
  try {
    const result = await pool.query("SELECT 1 as ok");
    res.json(result.rows);
  } catch (err) {
    console.error("DB ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

/*
=========================================================
AUTH: SIGNUP
=========================================================
1. Creates Supabase Auth user
2. Inserts into players table
3. Inserts into player_stats table
4. Email confirmation required (configured in Supabase)
*/
app.post("/auth/signup", async (req, res) => {
  try {
    const { email, password, username } = req.body;

    if (!email || !password || !username) {
      return res.status(400).json({ error: "email, password, username required" });
    }

    const { data, error } = await supabase.auth.signUp({
      email,
      password
    });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    const user = data.user;

    if (!user || !user.id) {
      return res.status(500).json({ error: "Auth user not created" });
    }

    await createPlayerRows(user.id, username);

    res.json({
      ok: true,
      userId: user.id,
      needsEmailConfirm: true
    });

  } catch (err) {
    console.error("SIGNUP ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

/*
=========================================================
AUTH: SIGNIN
=========================================================
Blocks login if email not verified.
*/
app.post("/auth/signin", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "email, password required" });
    }

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password
    });

    if (error) {
      return res.status(401).json({ error: error.message });
    }

    const user = data.user;
    const session = data.session;

    // Hard block if not verified
    if (!user.email_confirmed_at) {
      return res.status(403).json({ error: "EMAIL_NOT_VERIFIED" });
    }

    // Update last login timestamp
    await pool.query(
      "UPDATE players SET last_login_at = NOW() WHERE id = $1",
      [user.id]
    );

    res.json({
      ok: true,
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_in: session.expires_in,
      user: {
        id: user.id,
        email: user.email,
        email_confirmed_at: user.email_confirmed_at
      }
    });

  } catch (err) {
    console.error("SIGNIN ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

/*
=========================================================
AUTH: REFRESH SESSION
=========================================================
Used for silent auto-login.
*/
app.post("/auth/refresh", async (req, res) => {
  try {
    const { refresh_token } = req.body;

    if (!refresh_token) {
      return res.status(400).json({ error: "refresh_token required" });
    }

    const { data, error } = await supabase.auth.refreshSession({
      refresh_token
    });

    if (error) {
      return res.status(401).json({ error: error.message });
    }

    res.json({
      ok: true,
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_in: data.session.expires_in,
      user: {
        id: data.user.id,
        email: data.user.email,
        email_confirmed_at: data.user.email_confirmed_at
      }
    });

  } catch (err) {
    console.error("REFRESH ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

/*
=========================================================
AUTH: REQUEST PASSWORD RESET
=========================================================
Sends email with redirect to Make.com reset page.
*/
app.post("/auth/request-password-reset", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: "email required" });
    }

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: "https://hook.eu2.make.com/a6q4mncxc59oqmqwad20urj27oo2lfva"
    });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ ok: true });

  } catch (err) {
    console.error("RESET REQUEST ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

/*
=========================================================
AUTH: SET NEW PASSWORD
=========================================================
Called from Make.com reset page.
Uses access_token provided in email link.
*/
app.post("/auth/set-password", async (req, res) => {
	console.log("SET PASSWORD BODY:", req.body);
  try {
    const { access_token, new_password } = req.body;

    if (!access_token || !new_password) {
      return res.status(400).json({ error: "access_token and new_password required" });
    }

    const supabaseUser = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY,
      {
        global: {
          headers: { Authorization: `Bearer ${access_token}` }
        }
      }
    );

    const { error } = await supabaseUser.auth.updateUser({
      password: new_password
    });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.json({ ok: true });

  } catch (err) {
    console.error("SET PASSWORD ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

/*
=========================================================
MATCH CONFIG (unchanged)
=========================================================
*/
app.get("/match-config", async (req, res) => {
  try {
    const matchId = uuidv4();

    res.json({
      matchId,
      npcs: [
        { skill: 70, weapon: "rifle" },
        { skill: 90, weapon: "sniper rifle" },
        { skill: 50, weapon: "rifle" }
      ],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/*
=========================================================
MATCH RESULT (unchanged)
=========================================================
*/
app.post("/match-result", async (req, res) => {
  try {
    const { playerId, kills, win } = req.body;

    await pool.query(
      `
      UPDATE player_stats
      SET 
        matches_played = matches_played + 1,
        kills = kills + $1,
        wins = wins + $2
      WHERE player_id = $3
      `,
      [kills || 0, win ? 1 : 0, playerId]
    );

    res.json({ ok: true });

  } catch (err) {
    console.error("MATCH RESULT ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

/*
=========================================================
SERVER START
=========================================================
*/
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
