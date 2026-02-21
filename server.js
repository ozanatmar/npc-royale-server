console.log("-*-*-*-*- NEW SERVER VERSION -*-*-*-*-");

require("dotenv").config();

const express = require("express");
const cors = require("cors");

const app = express();

app.use(express.json());

app.use(cors({
  origin: "*", // can restrict later
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

const { Pool } = require("pg");
const { v4: uuidv4 } = require("uuid");
const { createClient } = require("@supabase/supabase-js");

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

/* Admin Client */
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/*
=========================================================
AUTH MIDDLEWARE (VALIDATE SUPABASE JWT)
=========================================================
- Reads Authorization: Bearer <access_token>
- Validates token via Supabase
- Exposes req.userId
*/
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const parts = authHeader.split(" ");

    if (parts.length !== 2 || parts[0] !== "Bearer") {
      return res.status(401).json({ error: "Missing Bearer token" });
    }

    const accessToken = parts[1];

    const { data, error } = await supabase.auth.getUser(accessToken);
    if (error || !data?.user?.id) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    req.userId = data.user.id;
    next();
  } catch (err) {
    console.error("AUTH MIDDLEWARE ERROR:", err);
    res.status(500).json({ error: "Auth middleware failed" });
  }
}

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
async function createPlayerRows(userId, username) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 1) players
    await client.query(
      `INSERT INTO players (id, username)
       VALUES ($1, $2)`,
      [userId, username]
    );

    // 2) player_stats
    await client.query(
      `INSERT INTO player_stats (player_id)
       VALUES ($1)`,
      [userId]
    );

    // 3) player_wallets (cash)
    const cashCurrency = await client.query(
      `SELECT id FROM currencies WHERE key = 'cash' LIMIT 1`
    );

    if (cashCurrency.rowCount === 0) {
      throw new Error("CASH_CURRENCY_NOT_FOUND");
    }

    await client.query(
      `INSERT INTO player_wallets (player_id, currency_id, balance)
       VALUES ($1, $2, $3)`,
      [userId, cashCurrency.rows[0].id, 0] // starting cash = 0
    );

    // 4) player_npcs
    await client.query(
      `INSERT INTO player_npcs (player_id, strength, perception, agility)
       VALUES ($1, 1, 1, 1)`,
      [userId]
    );
	
	await client.query(`
	  INSERT INTO player_equipment (player_id, slot, player_item_id)
	  VALUES ($1, 'weapon_primary', NULL)
	`, [userId]);

    await client.query("COMMIT");

  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
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
      return res.status(400).json({
        error: "email, password, username required"
      });
    }

    // Create Supabase auth user
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

    try {
      // Initialize DB rows (transaction)
      await createPlayerRows(user.id, username);

    } catch (dbError) {
      console.error("DB INIT FAILED:", dbError);

      // STRICT MODE: delete auth user
      await supabaseAdmin.auth.admin.deleteUser(user.id);

      return res.status(500).json({
        error: "ACCOUNT_INIT_FAILED"
      });
    }

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
    const { access_token, refresh_token, new_password } = req.body;

    if (!access_token || !refresh_token || !new_password) {
      return res.status(400).json({
        error: "access_token, refresh_token and new_password required"
      });
    }

    const supabaseUser = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    );

    // Establish session from recovery tokens
    const { error: sessionError } = await supabaseUser.auth.setSession({
      access_token,
      refresh_token
    });

    if (sessionError) {
      console.error("SESSION ERROR:", sessionError);
      return res.status(400).json({ error: sessionError.message });
    }

    // Update password
    const { error: updateError } = await supabaseUser.auth.updateUser({
      password: new_password
    });

    if (updateError) {
      console.error("UPDATE ERROR:", updateError);
      return res.status(400).json({ error: updateError.message });
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
PROFILE (Phase 19)
=========================================================
Returns unified player profile:
- players: id, username, mmr
- player_stats: matches_played, wins, kills, deaths
Requires Authorization Bearer access_token
*/
app.get("/profile", requireAuth, async (req, res) => {
  try {
    const userId = req.userId;

    const playerResult = await pool.query(
      "SELECT id, username, mmr FROM players WHERE id = $1",
      [userId]
    );

    if (playerResult.rowCount === 0) {
      return res.status(404).json({ error: "Player not found" });
    }

    const statsResult = await pool.query(
      "SELECT matches_played, wins, kills, deaths FROM player_stats WHERE player_id = $1",
      [userId]
    );

    if (statsResult.rowCount === 0) {
      return res.status(500).json({ error: "BROKEN_ACCOUNT_STATE" });
    }
	
	const walletResult = await pool.query(
	  `
	  SELECT pw.balance
	  FROM player_wallets pw
	  JOIN currencies c ON c.id = pw.currency_id
	  WHERE pw.player_id = $1 AND c.key = 'cash'
	  `,
	  [userId]
	);

	if (walletResult.rowCount === 0) {
	  return res.status(500).json({ error: "BROKEN_ACCOUNT_STATE" });
	}
	
	const npcResult = await pool.query(
	  "SELECT strength, perception, agility FROM player_npcs WHERE player_id = $1",
	  [userId]
	);

	if (npcResult.rowCount === 0) {
	  return res.status(500).json({ error: "BROKEN_ACCOUNT_STATE" });
	}

	const npc = npcResult.rows[0];
	const wallet = walletResult.rowCount > 0 ? walletResult.rows[0] : { balance: 0 };
    const player = playerResult.rows[0];
    const stats = statsResult.rows[0];

	return res.json({
	  player: {
		id: player.id,
		username: player.username,
		mmr: player.mmr
	  },
	  stats,
	  wallet: {
		cash: wallet.balance
	  },
	  npc: {
		strength: npc.strength,
		perception: npc.perception,
		agility: npc.agility
	  }
	});

  } catch (err) {
    console.error("PROFILE ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});
/*
app.get("/profile", requireAuth, async (req, res) => {
  try {
    const userId = req.userId;

    // 1) PLAYER
    const playerResult = await pool.query(
      "SELECT id, username, mmr FROM players WHERE id = $1",
      [userId]
    );

    if (playerResult.rowCount === 0) {
      return res.status(404).json({ error: "Player not found" });
    }

    const player = playerResult.rows[0];

    // 2) STATS
    const statsResult = await pool.query(
      "SELECT matches_played, wins, kills, deaths FROM player_stats WHERE player_id = $1",
      [userId]
    );

    if (statsResult.rowCount === 0) {
      return res.status(500).json({ error: "BROKEN_ACCOUNT_STATE" });
    }

    const stats = statsResult.rows[0];

    // 3) NPC
    const npcResult = await pool.query(
      "SELECT strength, perception, agility FROM player_npcs WHERE player_id = $1",
      [userId]
    );

    if (npcResult.rowCount === 0) {
      return res.status(500).json({ error: "BROKEN_ACCOUNT_STATE" });
    }

    const npc = npcResult.rows[0];

    // 4) WALLET (cash)
    const walletResult = await pool.query(
      `
      SELECT pw.balance
      FROM player_wallets pw
      JOIN currencies c ON c.id = pw.currency_id
      WHERE pw.player_id = $1 AND c.key = 'cash'
      `,
      [userId]
    );

    if (walletResult.rowCount === 0) {
      return res.status(500).json({ error: "BROKEN_ACCOUNT_STATE" });
    }

    const wallet = walletResult.rows[0];

    // 5) EQUIPMENT
    const equipmentResult = await pool.query(
      `
      SELECT pe.player_item_id, idf.key AS item_def_key
      FROM player_equipment pe
      LEFT JOIN player_items pi ON pi.id = pe.player_item_id
      LEFT JOIN item_defs idf ON idf.id = pi.item_def_id
      WHERE pe.player_id = $1 AND pe.slot = 'weapon_primary'
      `,
      [userId]
    );

    if (equipmentResult.rowCount === 0) {
      return res.status(500).json({ error: "BROKEN_ACCOUNT_STATE" });
    }

    const equipmentRow = equipmentResult.rows[0];

    // 6) INVENTORY
    const inventoryResult = await pool.query(
      `
      SELECT
        pi.id AS player_item_id,
        idf.id AS item_def_id,
        idf.key AS item_def_key,
        idf.base_props
      FROM player_items pi
      JOIN item_defs idf ON idf.id = pi.item_def_id
      WHERE pi.player_id = $1
      `,
      [userId]
    );

    const inventory = inventoryResult.rows.map(row => ({
      player_item_id: row.player_item_id,
      item_def_id: row.item_def_id,
      item_def_key: row.item_def_key,
      base_props: row.base_props
    }));

    // 7) STORE
    const storeResult = await pool.query(
      `
      SELECT
        id,
        key,
        base_props
      FROM item_defs
      WHERE is_active = true
        AND category = 'weapon'
      ORDER BY id
      `
    );

    const store = storeResult.rows.map(row => ({
      item_def_id: row.id,
      item_def_key: row.key,
      name: row.base_props?.name || row.key,
      icon_key: row.base_props?.icon_key || null,
      price_cash: row.base_props?.price_cash || 0
    }));

    // 8) FINAL RESPONSE
    return res.json({
      player: {
        id: player.id,
        username: player.username,
        mmr: player.mmr
      },
      stats: {
        matches_played: stats.matches_played,
        wins: stats.wins,
        kills: stats.kills,
        deaths: stats.deaths
      },
      npc: {
        strength: npc.strength,
        perception: npc.perception,
        agility: npc.agility
      },
      wallet: {
        cash: wallet.balance
      },
      equipment: {
        weapon_primary: {
          player_item_id: equipmentRow.player_item_id || null,
          item_def_key: equipmentRow.item_def_key || null
        }
      },
      inventory,
      store
    });

  } catch (err) {
    console.error("PROFILE ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});
*/

app.post("/profile/update-username", requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    const { username } = req.body;

    // Validate
    if (!username || username.length < 3 || username.length > 20) {
      return res.status(400).json({ error: "INVALID_LENGTH" });
    }

    const valid = /^[a-zA-Z0-9_]+$/.test(username);
    if (!valid) {
      return res.status(400).json({ error: "INVALID_FORMAT" });
    }

    // Friendly check (optional, UNIQUE constraint is still the real protection)
    const existing = await pool.query(
      "SELECT id FROM players WHERE username = $1",
      [username]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ error: "USERNAME_TAKEN" });
    }

    await pool.query(
      "UPDATE players SET username = $1 WHERE id = $2",
      [username, userId]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("UPDATE USERNAME ERROR:", err);

    // unique violation fallback
    if (err.code === "23505") {
      return res.status(400).json({ error: "USERNAME_TAKEN" });
    }

    res.status(500).json({ error: "SERVER_ERROR" });
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


app.get("/test-auth", requireAuth, (req, res) => {
  res.json({ ok: true, userId: req.userId });
});