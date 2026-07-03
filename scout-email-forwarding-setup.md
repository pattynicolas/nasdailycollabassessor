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
- Scout does not send anything to Lark while `SCOUT_EMAIL_AUTOMATION_LARK_MODE=draft_only`
