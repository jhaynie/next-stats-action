const path = require('path')
const fs = require('fs-extra')
const exec = require('../util/exec')
const logger = require('../util/logger')
const collectStats = require('./collect-stats')

const {
  mainRepoDir,
  diffRepoDir,
  statsAppDir
} = require('../constants')

module.exports = async function runConfigs(configs = [], {
  statsConfig,
  mainRepoPkgPaths,
  diffRepoPkgPaths,
}) {
  const results = []

  for (const config of configs) {
    logger(`Running config: ${config.title}`)

    // clean statsAppDir
    await fs.remove(statsAppDir)
    await fs.copy(
      path.join(diffRepoDir, '.stats-app'),
      statsAppDir
    )

    const origFiles = new Set(await fs.readdir(statsAppDir))
    let mainRepoStats
    let diffRepoStats

    for (const pkgPaths of [mainRepoPkgPaths, diffRepoPkgPaths]) {
      let curStats = {
        buildDuration: null,
        nodeModulesSize: null,
      }

      // remove any new files
      if (mainRepoStats) {
        for (const file of await fs.readdir(statsAppDir)) {
          if (!origFiles.has(file)) {
            await fs.remove(file)
          }
        }
      }

      // TODO: apply config files

      await linkPkgs(statsAppDir, pkgPaths)
      const buildStart = new Date().getTime()

      await exec(`cd ${statsAppDir} && ${statsConfig.appBuildCommand}`)
      curStats.buildDuration = new Date().getTime() - buildStart

      curStats = {
        ...curStats,
        ...(await collectStats(config.filesToTrack))
      }
      if (mainRepoStats) diffRepoStats = curStats
      else mainRepoStats = curStats

      // TODO: determine if we need to diff
    }
  }

  return results
}

async function linkPkgs(pkgDir = '', pkgPaths) {
  await fs.remove(path.join(pkgDir, 'node_modules'))

  const pkgJsonPath = path.join(pkgDir, 'package.json')
  const pkgData = require(pkgJsonPath)

  if (!pkgData.dependencies && !pkgData.devDependencies) return

  for (const pkg of pkgPaths.keys()) {
    const pkgPath = pkgPaths.get(pkg)

    if (pkgData.dependencies && pkgData.dependencies[pkg]) {
      pkgData.dependencies[pkg] = pkgPath
    }
    else if (pkgData.devDependencies && pkgData.devDependencies[pkg]) {
      pkgData.devDependencies[pkg] = pkgPath
    }
  }
  await fs.writeFile(pkgJsonPath, JSON.stringify(pkgData, null, 2), 'utf8')
  await exec(`cd ${pkgDir} && yarn install --prefer-offline`)
}
