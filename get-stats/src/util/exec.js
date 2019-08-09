const logger = require('./logger')
const { promisify } = require('util')
const { exec: execOrig } = require('child_process')

const execP = promisify(execOrig)
const env = {
  ...process.env,
  GITHUB_TOKEN: '',
  PR_STATS_COMMENT_TOKEN: '',
}

module.exports = function exec(command) {
  logger(`exec: ${command}`)
  return execP(command, { env })
}
