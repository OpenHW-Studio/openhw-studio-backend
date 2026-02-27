const express = require('express');
const router = express.Router();
const { compileArduinoCode } = require('../controllers/compileController');

// Compile Arduino code
router.post('/compile', compileArduinoCode);

module.exports = router;
