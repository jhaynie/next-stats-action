const {
  readdir: readdirOrig,
  stat: origStat,
  readFile: readFileOrig,
} = require('fs')
const { promisify } = require('util')
const { join } = require('path')

const readFile = promisify(readFileOrig)
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

async function getClientSizes(exec, serverless, TEST_PROJ_PATH, diff, isPR) {
  const staticPath = join(TEST_PROJ_PATH, '.next/static')
  const serverlessPath = join(TEST_PROJ_PATH, '.next/serverless/pages')

  const buildId = await readFile(join(TEST_PROJ_PATH, '.next/BUILD_ID'), 'utf8')
  const pagesPath = join(
    join(TEST_PROJ_PATH, '.next/static/', buildId, 'pages')
  )

  const runtimePath = join(staticPath, 'runtime')
  const chunksPath = join(staticPath, 'chunks')
  const runtimeFiles = await readdir(runtimePath)
  const chunkFiles = await readdir(chunksPath)
  const findFile = (files, pathPre = '', filter, modern = false) =>
    join(
      pathPre,
      files.find(f => f.includes(filter) && f.endsWith('module.js') === modern)
    )

  const sizes = {}
  const paths = {
    _appClientBytes: join(pagesPath, '_app.js'),
    _errClientBytes: join(pagesPath, '_error.js'),
    indexClientBytes: join(pagesPath, 'index.js'),
    linkPgClientBytes: join(pagesPath, 'link.js'),
    routerPgClientBytes: join(pagesPath, 'routerDirect.js'),
    withRouterPgClientBytes: join(pagesPath, 'withRouter.js'),
    clientWebpackBytes: findFile(runtimeFiles, runtimePath, 'webpack'),
    clientWebpackModernBytes: findFile(
      runtimeFiles,
      runtimePath,
      'webpack',
      true
    ),
    commonChunkBytes: findFile(chunkFiles, chunksPath, 'commons'),
    commonChunkModernBytes: findFile(chunkFiles, chunksPath, 'commons', true),
    clientMainBytes: findFile(runtimeFiles, runtimePath, 'main'),
    clientMainModernBytes: findFile(runtimeFiles, runtimePath, 'main', true),
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

  Object.keys(paths).forEach(key => {
    if (!key.endsWith('ClientBytes')) return
    paths[key + 'Modern'] = paths[key].replace(/\.js$/, '.module.js')
  })

  if (diff) {
    const diffDir = join(TEST_PROJ_PATH, '..', 'diff')
    await exec(`mkdir -p ${diffDir}`)
    const toDiff = {
      'main.js': 'clientMainBytes',
      'commons.js': 'commonChunkBytes',
      'webpack.js': 'clientWebpackBytes',
      'mainModern.js': 'clientMainModernBytes',
      'commonsModern.js': 'commonChunkModernBytes',
      'webpackModern.js': 'clientWebpackModernBytes',
    }
    const files = Object.keys(toDiff)

    for (const file of files) {
      const pathKey = toDiff[file]
      await exec(`cp ${paths[pathKey]} ${join(diffDir, file)}`)
    }

    if (isPR) {
      const diffs = {}
      for (const file of files) {
        const { stdout } = await exec(`cd ${diffDir} && git diff ${file}`)
        diffs[file] = (stdout || '').split(file).pop()
      }
      sizes.diffs = diffs
    } else {
      await exec(`cd ${diffDir} && git init && git add ${files.join(' ')}`)
    }
    return sizes
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
