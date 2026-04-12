const express = require('express');
const router = express.Router();
const db = require('../db/dynamo');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Get available dates for a program (used by calendar component)
router.get('/dates/:programId', asyncHandler(async (req, res) => {
  const programId = req.params.programId;
  const dates = await db.getDatesByProgram(programId);

  res.json(dates.map(d => ({
    date: d.date,
    capacity: d.maxCapacity,
    enrolled: d.enrolled || 0,
    available: d.maxCapacity - (d.enrolled || 0),
  })));
}));

module.exports = router;
