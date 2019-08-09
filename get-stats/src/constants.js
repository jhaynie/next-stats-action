const path = require('path')

const workDir = path.join(__dirname, '../.work')
const mainRepoName = 'main-repo'
const diffRepoName = 'diff-repo'
const mainRepoDir = path.join(workDir, mainRepoName)
const diffRepoDir = path.join(workDir, diffRepoName)
const statsAppDir = path.join(workDir, 'stats-app')

module.exports = {
  workDir,
  mainRepoName,
  diffRepoName,
  mainRepoDir,
  diffRepoDir,
  statsAppDir,
}
