# TeachingBoard Quiz Backend

Express + MongoDB backend for TeachingBoard quizzes. The backend stores the full quiz object as a single aggregate and is the source of truth for quiz delivery and attempt evaluation.

## Setup

1. Copy `.env.example` to `.env`.
2. Set `MONGODB_URI`, `JWT_SECRET`, and `CORS_ORIGIN`.
3. Install dependencies with `npm install`.
4. Start the API with `npm start`.

Required environment variables:

```env
PORT=4000
MONGODB_URI=mongodb+srv://<user>:<password>@cluster.mongodb.net/teachingboard
JWT_SECRET=change_this_to_a_long_random_secret
CORS_ORIGIN=http://localhost:5173,https://your-admin-domain.com,https://your-student-domain.com
```

## Render Deployment

1. Push this repo to GitHub/GitLab.
2. In Render, create a new `Web Service`.
3. Connect the repo root and use:
   - Build command: `npm install`
   - Start command: `node server.js`
4. Add `MONGODB_URI` and `JWT_SECRET` in Render.
5. Add `CORS_ORIGIN` only if you will call this API from a different frontend domain. If the frontend is served by the same Render service, the app now defaults to the same-origin `/api` endpoint.
6. Set the health check path to `/api/health`.

The repo root now includes a `render.yaml` and `server.js`, so the same GitHub repo can be deployed directly without manually changing the root directory. The existing [render.yaml](./render.yaml) can still be used if you prefer deploying only the `TeachingBoard-backend` folder.

## MongoDB Atlas

1. Create an Atlas cluster and database user.
2. Add the Render outbound IP or a temporary `0.0.0.0/0` access-list entry while testing.
3. Copy the SRV connection string and set it as `MONGODB_URI`.
4. Use a database name such as `teachingboard` in the URI path.

## API

- `GET /api/health`
- `POST /api/auth/login`
- `POST /api/quizzes`
- `GET /api/quizzes?status=published`
- `GET /api/quizzes/:id`
- `POST /api/attempts`

## Quiz Shape

```json
{
  "quiz_id": "quiz_123",
  "title": "Algebra Revision",
  "subject": "Math",
  "chapter": "Linear Equations",
  "batch": "Batch A",
  "status": "published",
  "timer_mode": "countdown",
  "timer_value": 900,
  "shuffle": true,
  "questions": [
    {
      "q_id": "q_1",
      "question": "2 + 2 = ?",
      "options": ["3", "4", "5", "6"],
      "answer": "4",
      "image": null
    }
  ]
}
```
