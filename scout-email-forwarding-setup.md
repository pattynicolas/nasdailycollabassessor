Scout email forwarding test setup

Environment variables

- `SCOUT_INBOUND_EMAIL_SECRET`
  Shared secret that your email-forwarding bridge sends to Scout.
- `SCOUT_EMAIL_AUTOMATION_LARK_MODE`
  Use `draft_only` for testing. Switch to `live` only when you want automatic Lark posting.
- `SCOUT_EMAIL_AUTOMATION_TEST_RECEIVE_ID`
  Optional test Lark target. Only needed once `SCOUT_EMAIL_AUTOMATION_LARK_MODE=live`.
- `SCOUT_EMAIL_AUTOMATION_TEST_RECEIVE_ID_TYPE`
  Usually `chat_id`.

Inbound endpoint

- `POST /api/inbound-email`
- Header: `X-Scout-Inbound-Secret: <SCOUT_INBOUND_EMAIL_SECRET>`
- Forwarding to `scoutproposal@nas.com` only works if your email bridge POSTs that forwarded message to this endpoint.
- The endpoint stores the proposal, generates Scout's assessment, and returns a `lark_draft` for review.

Sample JSON payload

```json
{
  "from": "sender@example.com",
  "to": "scoutproposal@nas.com",
  "subject": "Invitation to speak at Example Summit",
  "text": "Forwarded message body here...",
  "messageId": "<abc123@example.com>",
  "attachments": [
    {
      "fileName": "screenshot.png",
      "mimeType": "image/png",
      "data": "BASE64_HERE"
    }
  ]
}
```

Expected test behavior

- Scout assesses the forwarded email
- Scout saves the proposal to the database
- Scout returns a `lark_draft`
- Scout does not send anything to live Nuseir unless you explicitly wire a separate approval/send step

Lark send safety for manual messages

- Set `COLLAB_ASSESSOR_LARK_MESSAGE_MODE=test` while testing
- Add the test chat receive ID to `COLLAB_ASSESSOR_LARK_TEST_RECEIVE_ID`
- Add the matching type to `COLLAB_ASSESSOR_LARK_TEST_RECEIVE_ID_TYPE` (usually `chat_id`)
- Keep `COLLAB_ASSESSOR_LARK_NUSEIR_RECEIVE_ID` untouched for the live target
- Add only the test chat or test user receive ID to `COLLAB_ASSESSOR_LARK_ALLOWED_RECEIVE_IDS`
- Do not include the live group receive ID in that list
- If the allowlist is empty, Scout refuses to send a Lark message

Testing the simplified card layout

1. Keep `COLLAB_ASSESSOR_LARK_MESSAGE_MODE=test`.
2. Set `COLLAB_ASSESSOR_LARK_TEST_RECEIVE_ID` to a separate group chat ID.
3. Set `COLLAB_ASSESSOR_LARK_TEST_RECEIVE_ID_TYPE=chat_id` unless you are testing a user/email target.
4. Put only the test group ID in `COLLAB_ASSESSOR_LARK_ALLOWED_RECEIVE_IDS`.
5. Leave the live Nuseir receive ID out of the allowlist.
6. Restart Scout after changing env vars.
7. Trigger the outbound assessment flow.
8. Confirm the new card appears in the test group.
9. When the layout looks right, switch `COLLAB_ASSESSOR_LARK_MESSAGE_MODE=live`.
10. Add the live Nuseir receive ID to `COLLAB_ASSESSOR_LARK_ALLOWED_RECEIVE_IDS`.
11. Send one more message only after you are ready for Nuseir to see the new layout.
