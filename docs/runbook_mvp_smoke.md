# NPC Royale MVP Smoke Test Runbook

## Preconditions
- Render API base URL is reachable:
  - GET /ping returns 200
- You have a test account (email verified)
- UE project builds and PIE runs

## Render endpoints used
- POST /auth/signin
- POST /auth/refresh
- GET  /profile
- POST /store/buy
- POST /equipment/equip
- POST /match-result

## Manual Smoke Steps (Menu → Store → Equip → Match → Reward)
1) Launch the game
   - Expected: loading screen visible immediately (no black flash)
2) Auto-login path
   - If session exists: should log in and fetch profile automatically
   - If not: sign-in screen appears
3) Sign in (if needed)
   - Expected: OnAuthStateChanged(true) fires
   - Expected: profile fetch begins
4) Profile loaded
   - Expected: username, MMR, stats, cash visible
5) Store
   - Expected: store weapon list appears (at least 3 items)
   - Buy a weapon
     - If cash is enough: purchase succeeds and cash decreases
     - If not: NOT_ENOUGH_CASH shown
6) Inventory
   - Expected: purchased weapon appears as a new inventory instance
7) Equip
   - Equip one weapon into weapon_primary
   - Expected: loadout shows the equipped weapon
8) Start a match
   - Expected: player NPC spawns with equipped weapon
9) End match
   - Expected: results show kills, placement, win/loss
10) Submit match result
   - Expected: server returns reward_cash
11) Refresh profile (automatically or via FetchProfile)
   - Expected: cash increased by reward
   - Expected: matches_played +1
   - Expected: wins +1 if win
   - Expected: kills added
   - Expected: deaths +1 only on loss (player NPC dies)

## Pass/Fail
PASS if the full loop works end-to-end and all expected deltas appear in profile.
FAIL if any endpoint fails, cash/stats deltas are wrong, or UI does not update from events.