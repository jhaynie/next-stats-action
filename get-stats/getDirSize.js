const { readdir: readdirOrig, stat: origStat } = require('fs')
const { promisify } = require('util')
const { join } = require('path')

const readdir = promisify(readdirOrig)
const stat = promisify(origStat)

// getDirSize recursively gets size of all files in a directory
async function getDirSize(path, ctx = { size: 0 }) {
  let paths = await readdir(path)
  paths = paths.map(p => join(path, p))

  await Promise.all(
    paths.map(async curPath => {
      const fileStat = await stat(curPath)
      if (fileStat.isDirectory()) {
        return getDirSize(curPath, ctx)
      }
      ctx.size += fileStat.size
    })
  )
  return ctx.size
}

module.exports = getDirSize
