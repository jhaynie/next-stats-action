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

async function getFileSize(path) {
  const stats = await stat(path)
  return stats.size
}

async function getClientSizes(exec, serverless, TEST_PROJ_PATH) {
  const staticPath = join(TEST_PROJ_PATH, '.next/static')
  const serverlessPath = join(TEST_PROJ_PATH, '.next/serverless/pages')

  const { stdout: pagesPath } = await exec(`find ${staticPath} -name 'pages'`)
  const { stdout: commonsPath } = await exec(
    `find ${staticPath} -name 'commons*.js'`
  )
  const { stdout: mainPath } = await exec(`find ${staticPath} -name 'main*.js'`)
  const { stdout: webpackPath } = await exec(
    `find ${staticPath} -name 'webpack*.js'`
  )
  const cleanPgsPath = pagesPath.trim()
  const sizes = {}
  const paths = {
    _appClientBytes: join(cleanPgsPath, '_app.js'),
    _errClientBytes: join(cleanPgsPath, '_error.js'),
    indexClientBytes: join(cleanPgsPath, 'index.js'),
    linkPgClientBytes: join(cleanPgsPath, 'link.js'),
    routerPgClientBytes: join(cleanPgsPath, 'routerDirect.js'),
    withRouterPgClientBytes: join(cleanPgsPath, 'withRouter.js'),
    commonChunkBytes: commonsPath.trim(),
    clientMainBytes: mainPath.trim(),
    clientWebpackBytes: webpackPath.trim(),
    ...(serverless
      ? {
          indexServerlessBytes: join(serverlessPath, 'index.js'),
          linkPgServerlessBytes: join(serverlessPath, 'link.js'),
          _errorServerlessBytes: join(serverlessPath, '_error.js'),
          routerPgServerlessBytes: join(serverlessPath, 'routerDirect.js'),
          withRouterPgServerlessBytes: join(serverlessPath, 'withRouter.js'),
        }
      : {}),
  }

  for (const key of Object.keys(paths)) {
    const gzipKey = key.replace('Bytes', 'Gzip')
    const path = paths[key]
    try {
      sizes[key] = await getFileSize(path)
      await exec(`gzip ${path} -c > ${path}.gz`)
      sizes[gzipKey] = await getFileSize(`${path}.gz`)
    } catch (error) {
      sizes[key] = 'Error getting size'
      sizes[gzipKey] = 'Error getting size'
      console.error(`Failed to get size for ${path}:`, error)
    }
  }
  return sizes
}

module.exports = {
  getDirSize,
  getFileSize,
  getClientSizes,
}
