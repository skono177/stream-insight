const { cpSync, mkdirSync } = require('node:fs');
const { dirname } = require('node:path');

const [, , source, destination] = process.argv;
if (!source || !destination) {
  throw new Error('Source and destination paths are required');
}

mkdirSync(dirname(destination), { recursive: true });
cpSync(source, destination, { recursive: true, errorOnExist: true, force: false });
