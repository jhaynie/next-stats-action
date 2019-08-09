const path = require('path')
const fs = require('fs-extra')
const exec = require('../util/exec')
const { remove } = require('fs-extra')

module.exports = actionInfo => {
  return {
    async cloneRepo(repoPath = '', dest = '') {
      await remove(dest)
      await exec(`git clone ${actionInfo.gitRoot}${repoPath} ${dest}`)
    },
    async checkoutRef(ref = '', repoDir = '') {
      await exec(`cd ${repoDir} && git fetch && git checkout ${ref}`)
    },
    async resetToRef(ref = '', repoPath = '') {
      await exec(`cd ${repoPath} && git reset --hard ${ref}`)
    },
    async linkPackages(repoDir = '') {
      await fs.remove(path.join(repoDir, 'node_modules'))
      const pkgs = await fs.readdir(path.join(repoDir, 'packages'))
      const pkgPaths = new Map()

      for (const pkg of pkgs) {
        const pkgPath = path.join(repoDir, 'packages', pkg)
        pkgPaths.set(pkg, pkgPath)
        await fs.remove(path.join(pkgPath, 'node_modules'))

        const pkgDataPath = path.join(pkgPath, 'package.json')
        const pkgData = require(pkgDataPath)

        for (const pkg of pkgs) {
          if (!pkgData.dependencies || !pkgData.dependencies[pkg]) continue
          pkgData.dependencies[pkg] = path.join(repoDir, 'packages', pkg)
        }
        await fs.writeFile(
          pkgDataPath,
          JSON.stringify(pkgData, null, 2),
          'utf8'
        )
      }
      return pkgPaths
    },
  }
}
