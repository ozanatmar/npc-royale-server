/* scripts/mvp_smoke.js
   Runs against Render API (does NOT run your server locally)
   Usage:
     - Add env vars to .env (not committed)
     - node scripts/mvp_smoke.js
*/

require("dotenv").config();

const BASE_URL = process.env.RENDER_BASE_URL || "https://npc-royale-server.onrender.com";
const TEST_EMAIL = process.env.TEST_EMAIL;
const TEST_PASSWORD = process.env.TEST_PASSWORD;

// Optional (only needed once endpoints exist)
const TEST_ITEM_DEF_ID = process.env.TEST_ITEM_DEF_ID ? Number(process.env.TEST_ITEM_DEF_ID) : null;

function must(v, name) {
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

async function http(method, path, body, accessToken) {
  const headers = { "Content-Type": "application/json" };
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await res.text();
  let json = null;

  try { json = text ? JSON.parse(text) : null; } catch {}

  return { status: res.status, ok: res.ok, json, text };
}

async function main() {
  must(TEST_EMAIL, "TEST_EMAIL");
  must(TEST_PASSWORD, "TEST_PASSWORD");

  console.log("1) ping...");
  const ping = await http("GET", "/ping");
  console.log("   status:", ping.status, "body:", ping.text);
  if (!ping.ok) process.exit(1);

	console.log("2) signin...");
	console.log("   email:", TEST_EMAIL);
  const signin = await http("POST", "/auth/signin", { email: TEST_EMAIL, password: TEST_PASSWORD });
  if (!signin.ok) {
    console.error("signin failed:", signin.status, signin.text);
    process.exit(1);
  }

  const access = signin.json.access_token;
  console.log("   signed in. user:", signin.json.user?.id);

  console.log("3) GET /profile...");
  const prof1 = await http("GET", "/profile", null, access);
  if (!prof1.ok) {
    console.error("profile failed:", prof1.status, prof1.text);
    process.exit(1);
  }
  const cashBefore = prof1.json.wallet?.cash;
  const matchesBefore = prof1.json.stats?.matches_played;
  console.log("   cashBefore:", cashBefore, "matchesBefore:", matchesBefore);

  if (TEST_ITEM_DEF_ID) {
    console.log("4) POST /store/buy...");
    const buy = await http("POST", "/store/buy", { item_def_id: TEST_ITEM_DEF_ID }, access);
    console.log("   buy status:", buy.status, buy.text);
    if (!buy.ok) {
      console.error("buy failed:", buy.status, buy.text);
      process.exit(1);
    }
  } else {
    console.log("4) POST /store/buy skipped (set TEST_ITEM_DEF_ID in .env)");
  }

  console.log("5) POST /match-result (sample) ...");
  const match = await http("POST", "/match-result", { kills: 2, placement: 50, win: false }, access);
  console.log("   match status:", match.status, match.text);
  if (!match.ok) {
    console.error("match-result failed:", match.status, match.text);
    process.exit(1);
  }

  console.log("6) GET /profile again...");
  const prof2 = await http("GET", "/profile", null, access);
  if (!prof2.ok) {
    console.error("profile2 failed:", prof2.status, prof2.text);
    process.exit(1);
  }

  const cashAfter = prof2.json.wallet?.cash;
  const matchesAfter = prof2.json.stats?.matches_played;
  console.log("   cashAfter:", cashAfter, "matchesAfter:", matchesAfter);

  console.log("7) basic assertions...");
  if (matchesAfter !== matchesBefore + 1) {
    throw new Error(`matches_played did not increment by 1 (${matchesBefore} -> ${matchesAfter})`);
  }

  console.log("DONE ✅");
}

main().catch((e) => {
  console.error("SMOKE FAILED:", e.message);
  process.exit(1);
});