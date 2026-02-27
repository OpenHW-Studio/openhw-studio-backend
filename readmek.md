# 🖥️ OpenHW-Studio: Compiler Backend

> **Role:** Orchestrates the compilation of human-readable Arduino C++ code into machine-level `.hex` files.

---

## 🚀 Key Integrations

*   **Express Server & CORS**
    *   Server listens on `http://localhost:5000`.
    *   Configured with CORS to accept compilation payloads from the React frontend seamlessly.
*   **Compilation Pipeline (`/api/compile`)**
    *   Receives `POST` requests containing raw C++ code.
    *   Writes code to uniquely hashed `.ino` temporary files stored in `temp/`.
    *   Executes `arduino-cli.exe` via `child_process` to target the `arduino:avr:uno` FQBN.
*   **Artifact Management**
    *   Safely extracts the generated `.hex` data for transmission back to the frontend.
    *   Implements recursive garbage collection on `temp/` to prevent disk bloat.
*   **Stability Patches**
    *   Implemented a custom `nodemon.json` config.
    *   Forces Nodemon to ignore the `temp/` directory, preventing catastrophic `ERR_CONNECTION_RESET` loops during active compilation.
*   **Repository Hygiene**
    *   Added a strict `.gitignore` to prevent tracking of dynamic artifact files (`.ino`, `.hex`).

---
*Generated for the Universal Emulator Integration.*
