# OpenHW Studio — Compiler Backend

> The Express.js REST API server that compiles Arduino C++ sketches into `.hex` machine code using `arduino-cli`, and handles user authentication and data storage via MongoDB.

---

## Table of Contents

- [Overview](#overview)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [API Endpoints](#api-endpoints)
- [Key Features](#key-features)
- [Setup & Running Locally](#setup--running-locally)
- [Environment Variables](#environment-variables)

---

## Overview

The Compiler Backend is the **central API server** for OpenHW Studio. It:

- Accepts Arduino C++ source code from the frontend
- Invokes `arduino-cli.exe` to compile it into an AVR `.hex` file
- Returns the `.hex` payload to the frontend for simulation
- Handles user **authentication** (login / registration) using JWT + bcrypt
- Manages **library installation** via `arduino-cli` library commands
- Connects to **MongoDB** for user and project data persistence

The server runs on **http://localhost:5000**.

---

## Tech Stack

| Technology | Purpose |
|---|---|
| Node.js + Express | Web server and REST API |
| arduino-cli | Compiling Arduino C++ to AVR `.hex` |
| Mongoose | MongoDB object modelling |
| JSON Web Tokens (JWT) | Stateless authentication |
| bcryptjs | Password hashing |
| dotenv | Environment variable management |
| cors | Cross-origin request handling |
| nodemon | Auto-reload during development |

---

## Project Structure

```
openhw-studio-backend-danish/
├── src/
│   ├── server.js                   # Entry point — Express app setup & startup
│   ├── controllers/
│   │   ├── compileController.js    # POST /api/compile — runs arduino-cli
│   │   ├── libController.js        # Library search & install via arduino-cli
│   │   ├── componentController.js  # Asset Registry & Approval pipeline
│   │   └── userController.js       # Admin & User profile management
│   ├── routes/
│   │   └── api.js                  # Route definitions
│   ├── models/                     # Mongoose data models (users, projects, etc.)
│   ├── db/                         # MongoDB connection setup
│   └── middleware/                 # Auth middleware (JWT verification)
├── temp/                           # Temporary .ino/.hex files (auto-cleaned)
├── env                             # Environment variables file (not committed)
├── nodemon.json                    # Nodemon config (ignores temp/)
├── package.json
└── .gitignore
```

---

## API Endpoints

### Compilation

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/compile` | Compile Arduino C++ code → returns `.hex` |

**Request body:**
```json
{
  "code": "#include <Arduino.h>\nvoid setup() { ... }\nvoid loop() { ... }"
}
```

**Response:**
```json
{
  "hex": ":100000000C945C000C9479000C94790..."
}
```

### Library Management

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/libraries/search?q=Servo` | Search arduino-cli library index |
| `POST` | `/api/libraries/install` | Install a named library via arduino-cli |

### Component Registry & Pipeline

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/components/submit` | Users upload a custom component (ZIP content) for review |
| `GET` | `/api/admin/components/pending` | List all submissions waiting for admin approval |
| `POST` | `/api/admin/components/approve` | Permanently merge a submission into the emulator library |
| `DELETE` | `/api/admin/components/reject/:subId` | Reject a specific submission by its unique ID |
| `GET` | `/api/admin/components/installed` | List all manually installed custom components |
| `DELETE` | `/api/admin/components/installed/:id` | Remove an installed component from the emulator |

### Authentication

---

## Key Features

### ⚙️ Compilation Pipeline (`compileController.js`)

1. Receives raw C++ code via `POST /api/compile`
2. Creates a uniquely named temporary `.ino` sketch file in `temp/`
3. Executes `arduino-cli.exe compile` targeting the `arduino:avr:uno` FQBN via Node's `child_process.execFile`
4. Extracts the generated `.hex` content from the build output
5. Sends the `.hex` string back to the frontend
6. **Cleans up** the temporary directory recursively to prevent disk bloat

### 📚 Library Management (`libController.js`)

- Wraps `arduino-cli lib search` and `arduino-cli lib install` as API endpoints
- Allows the frontend's Library Manager UI to search and install Arduino libraries at runtime

### 🛡️ Component Review Pipeline (`componentController.js`)

- **unique submissonIds**: Each upload gets a timestamped ID so rejecting one doesn't affect other pending versions.
- **Permanent Integration**: Approval physically writes the `ui.tsx`, `logic.ts`, etc., to the emulator's component directory and updates its registry.
- **Atomic Rejection**: One-click removal of specific submissions from the in-memory pending store.

### 🔐 Authentication

### 🛡️ Stability: nodemon + temp/ Ignore

The `nodemon.json` explicitly ignores the `temp/` directory. Without this, file changes inside `temp/` (created during active compilation) would cause nodemon to restart the server mid-compilation, resulting in `ERR_CONNECTION_RESET` errors on the frontend.

```json
// nodemon.json
{
  "ignore": ["temp/"]
}
```

---

## Setup & Running Locally

### Prerequisites

- **Node.js 18+**
- **npm 9+**
- **MongoDB** running locally (or a MongoDB Atlas connection string)
- **arduino-cli** installed and on your system PATH (or placed in the project root)
  - Download: https://arduino.github.io/arduino-cli/latest/installation/
  - After installing, run: `arduino-cli core install arduino:avr`

### Installation

```bash
cd openhw-studio-backend-danish
npm install
```

### Configure Environment

Create a file named `env` in the project root (this file is gitignored):

```env
PORT=5000
MONGO_URI=mongodb://localhost:27017/openhw-studio
JWT_SECRET=your_secret_key_here
```

### Start the Server

```bash
# Development (auto-reload with nodemon)
npm run dev

# Production
npm start
```

Server will be available at **http://localhost:5000**

---

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `PORT` | Port the server listens on | `5000` |
| `MONGO_URI` | MongoDB connection string | — |
| `JWT_SECRET` | Secret key for signing JWTs | — |

---

*Part of the OpenHW Studio platform. See also: [OpenHW-studio-frontend-danish](../OpenHW-studio-frontend-danish) and [openhw-studio-emulator-danish](../openhw-studio-emulator-danish).*
