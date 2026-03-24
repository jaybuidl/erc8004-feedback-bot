#!/usr/bin/env node
// Validate environment configuration by loading the config
require('dotenv').config();
const { getConfig } = require('../dist/src/config');

try {
  getConfig();
  console.log('✅ Configuration is valid');
  process.exit(0);
} catch (err) {
  console.error('❌ Configuration validation failed:', err.message);
  process.exit(1);
}
