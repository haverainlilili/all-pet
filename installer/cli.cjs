#!/usr/bin/env node
'use strict';

const { main } = require('./install.cjs');

main(process.argv.slice(2)).catch(error => {
  console.error(`\nAllPet: ${error.message}`);
  console.error('手动安装 / Manual download: https://github.com/haverainlilili/all-pet/releases/latest');
  process.exitCode = 1;
});
