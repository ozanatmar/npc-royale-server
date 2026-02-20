# NPC Royale MVP Error Codes

## General
- UNAUTHORIZED
  - Meaning: Missing/invalid access token
  - UI: "Session expired. Please sign in again."
  - Retry: No (must re-auth)

- BROKEN_ACCOUNT_STATE
  - Meaning: required rows missing (wallet/npc/stats), DB is inconsistent
  - UI: "Account initialization issue. Contact support."
  - Retry: No

## /auth/signup
- EMAIL_NOT_VERIFIED (returned on signin, not signup)
- (Supabase errors pass-through)
  - UI: show message

## /auth/signin
- EMAIL_NOT_VERIFIED
  - UI: "Please verify your email."

## /auth/refresh
- (Supabase errors pass-through)
  - UI: "Session expired. Please sign in again."

## /profile/update-username
- USERNAME_TAKEN
  - UI: "Username is already taken."
- INVALID_USERNAME
  - UI: "Invalid username."

## GET /profile
- BROKEN_ACCOUNT_STATE
- UNAUTHORIZED

## POST /store/buy
- ITEM_NOT_FOUND
  - UI: "Item not found."
- ITEM_INACTIVE
  - UI: "Item not available."
- INVALID_PRICE
  - UI: "Item price invalid."
- NOT_ENOUGH_CASH
  - UI: "Not enough cash."

## POST /equipment/equip
- INVALID_SLOT
  - UI: "Invalid slot."
- ITEM_NOT_OWNED
  - UI: "You do not own this item."
- INVALID_ITEM
  - UI: "This item cannot be equipped."

## POST /match-result
- INVALID_KILLS
- INVALID_PLACEMENT
- INVALID_BODY
  - UI: "Invalid match result."
- UNAUTHORIZED