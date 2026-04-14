# TeachingBoard Backend

Node.js + Express + MySQL backend for the existing TeachingBoard frontend.

## Quick Start

1. Copy `.env.example` to `.env` and fill in MySQL credentials.
2. Create the database and tables using `db/schema.sql`.
3. Install dependencies with `npm install`.
4. Start the server with `npm start`.

## API

- `POST /api/login`
- `GET /api/questions`
- `POST /api/questions`
- `PUT /api/questions/:id`
- `DELETE /api/questions/:id`
- `GET /api/quiz`
- `POST /api/submit`

## Default Admin Login

- `role`: `admin`
- `pin`: `1234`
