const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
// const connectDB = require('./src/db/connections'); 
const apiRoutes = require('./src/routes/api');
const fs = require('fs');
const path = require('path');

// Load environment variables
dotenv.config();

// Ensure temp directory exists
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir);
}

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use('/api', apiRoutes);

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
    console.log(`OpenHW Studio Backend running on port ${PORT}`);
});
