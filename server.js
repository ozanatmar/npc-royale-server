require("dotenv").config();

const express = require("express");
const { Pool } = require("pg");
const { v4: uuidv4 } = require("uuid");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ----------------------------
// DATABASE (Supabase Postgres)
// ----------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

// ----------------------------
// HEALTH CHECK
// ----------------------------
app.get("/ping", async (req, res) => {
  try {
    console.log("Trying DB connection...");
    const result = await pool.query("SELECT 1 as ok");
    console.log("DB SUCCESS");
    res.json(result.rows);
  } catch (err) {
    console.error("FULL DB ERROR:");
    console.error(err);
    res.status(500).json({ error: err.message || "DB failed" });
  }
});

// ----------------------------
// CREATE PLAYER
// ----------------------------
app.post("/player/create", async (req, res) => {
  try {
    const { username } = req.body;

    if (!username) {
      return res.status(400).json({ error: "Username required" });
    }

    const id = uuidv4();

    await pool.query(
      "INSERT INTO players (id, username) VALUES ($1, $2)",
      [id, username]
    );

    await pool.query(
      "INSERT INTO player_stats (player_id) VALUES ($1)",
      [id]
    );

    res.json({ id, username });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------
// MATCH CONFIG
// ----------------------------
app.get("/match-config", async (req, res) => {
  try {
    const matchId = uuidv4();

    res.json({
      matchId,
      npcs: [
        { skill: 70, weapon: "rifle" },
        { skill: 90, weapon: "sniper rifle" },
        { skill: 50, weapon: "rifle" },
      ],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------
// MATCH RESULT
// ----------------------------
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
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
