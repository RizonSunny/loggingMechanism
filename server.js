const express = require('express');
const path = require('path');
const { createLogger } = require('./shared/logger');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const logger = createLogger({ service: 'frontend', version: '1.0.0' });

const PORT = 3000;
app.listen(PORT, () => {
  // INFO — service lifecycle event: the UI server is up
  // Previously this was console.log — now it's structured and parseable by ELK
  logger.info('API Tester UI started', { port: PORT, url: `http://localhost:${PORT}` });
});
