# Ask your CA

A standalone team app for day-to-day questions on accounting, audit, income tax, GST, TDS, ROC/MCA compliance, costing, FEMA and finance. Its answers draw on the combined knowledge of a CA, CS, CMA and practising lawyer, covering both the textbook and the practical side.

It is fully separate from the billing app in the parent folder. It has its own server, logins and data.

## What it does

- **Team logins.** Each person (4–5 users) logs in with their own name and password. Every question is recorded with who asked it.
- **One shared knowledge base.** Every question, answer and team note is stored centrally, and everyone on the team sees every discussion. Anyone can continue any discussion.
- **Reuse of past discussions.** When a new question touches something discussed before, the advisor searches the knowledge base. It then builds on the earlier answer and names it ("see team discussion … , 12 Aug 2026"). It re-checks anything that may have changed since. Each answer lists the past discussions it looked at, and you can click through to them.
- **Team notes.** Inside any discussion you can add a note about what you actually did or decided, e.g. "Filed reply on 12 Nov; officer accepted it." Notes carry extra weight in later answers.
- **Current law.** The advisor searches the web for the latest notifications, circulars and due dates, preferring government and institute sites. It lists its sources under each answer.
- **Search.** The search box in the sidebar searches every past question, answer and note.

## Setup

Requires Node.js 18 or later.

```bash
cd ask-your-ca
npm install
```

Set these environment variables (on a host, add them as secrets):

| Variable | Required | What it is |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Claude API key from console.anthropic.com |
| `ASKCA_USERS` | yes | Team logins as `Name:password` pairs separated by commas, e.g. `Ramesh:pass-one,Sita:pass-two,Arjun:pass-three` |
| `SESSION_SECRET` | yes | Any long random string. It keeps people logged in across restarts. |
| `DATABASE_URL` | for hosting | Postgres connection string. Without it, data is saved to `data/askca.json`. |
| `PGSSL` | no | Set to `disable` if your Postgres does not use SSL (e.g. a local database) |
| `PORT` | no | Defaults to 4500 |
| `ASK_CA_MODEL` | no | Defaults to `claude-opus-5-5` |
| `ASK_CA_EFFORT` | no | `low` / `medium` / `high` (default) / `xhigh` / `max`. Higher is more thorough, slower and costlier. |

```bash
npm start
```

Then open http://localhost:4500.

**Hosting:** use Postgres (`DATABASE_URL`). Many hosts wipe local files on each deploy, which would erase the knowledge base. Tables are created automatically on first start.

**Adding or removing a person:** edit `ASKCA_USERS` and restart. Someone removed from the list loses access immediately, but their past questions and notes stay in the knowledge base.

## Notes

- Only the person who started a discussion can delete it. Deleting removes it from the knowledge base for everyone.
- If two people ask in the same discussion at the same moment, the second is asked to wait for the first answer.
- An answer that fails or is interrupted is not saved, so the knowledge base holds only complete answers.
- Cost: Claude Opus 5.5 is billed at $4 per million input tokens and $20 per million output tokens, plus web searches. Long discussions cost more per question, because the whole discussion is sent each time. Start a new discussion for a new topic.
- Answers are guidance, not a signed professional opinion.
