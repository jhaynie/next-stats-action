const { join } = require('path')
const fetch = require('node-fetch')
const pidUsage = require('pidusage')
const { promisify } = require('util')
const finishedStats = require('./formatStats')
const { writeFile: writeFileOrig } = require('fs')
const { exec: execSync, spawn } = require('child_process')
const { getDirSize, getClientSizes } = require('./getSizes')

const execP = promisify(execSync)
const writeFile = promisify(writeFileOrig)
const exec = cmd => execP(cmd, { env: { ...process.env, GITHUB_TOKEN: '' } })

const {
  GITHUB_EVENT_PATH,
  GITHUB_REPOSITORY,
  GITHUB_REF,
  GITHUB_TOKEN,
} = process.env

const TEST_PROJ_PATH = join('/', 'test-project')
const EVENT_DATA = require(GITHUB_EVENT_PATH)

const ACTION = EVENT_DATA['action']
const PR_DATA = EVENT_DATA['pull_request']
// Since GITHUB_REPOSITORY and REF might not match the fork
// use event data to get repo and ref info
const PR_REPO = PR_DATA['head']['repo']['full_name']
const PR_REF = PR_DATA['head']['ref']
const COMMENT_API_ENDPOINT = PR_DATA['_links']['comments']

const MAIN_REF = 'canary'
const MAIN_REPO = 'zeit/next.js'
const GIT_ROOT = 'https://github.com/'

if (!GITHUB_REPOSITORY || !GITHUB_REF) {
  throw new Error(
    `'GITHUB_REF' or 'GITHUB_REPOSITORY' environment variable was missing`
  )
}

if (ACTION !== 'synchronize' && ACTION !== 'opened') {
  console.log('Not running for', ACTION, 'event action')
  process.exit(0)
}

console.log(
  `Got repo url: ${GITHUB_REPOSITORY} and branch/ref: ${GITHUB_REF}\n` +
    `Using repo url: ${PR_REPO} and branch/ref: ${PR_REF}\n`
)

const checkoutRepo = async (repo, ref, outDir) => {
  const url = GIT_ROOT + repo
  console.log(`Cloning ${url} to ${outDir}`)
  await exec(`rm -rf ${outDir}`)
  await exec(`git clone ${url} ${outDir}`)
  await exec(`cd ${outDir} && git checkout ${ref}`)
}

const buildRepo = async dir => {
  console.log(`Building next in ${dir}`)
  await exec(`cd ${dir} && yarn install`)
}

const setupTestProj = async repoDir => {
  const absRepoDir = join(process.cwd(), repoDir)

  console.log(`Cleaning .next and node_modules in test-project`)
  await exec(`cd ${TEST_PROJ_PATH} && rm -rf .next node_modules`)
  await exec(`cd ${absRepoDir} && rm -rf packages/**/node_modules`)

  const tstPkgPath = join(TEST_PROJ_PATH, 'package.json')
  const nextPath = join(absRepoDir, 'packages/next')
  const nextPkgPath = join(nextPath, 'package.json')
  const tstPkg = require(tstPkgPath)
  const nextPkg = require(nextPkgPath)

  tstPkg.dependencies.next = `file:${nextPath}`
  await writeFile(tstPkgPath, JSON.stringify(tstPkg, null, 2))

  nextPkg.dependencies['next-server'] =
    'file:' + join(absRepoDir, 'packages/next-server')
  await writeFile(nextPkgPath, JSON.stringify(nextPkg, null, 2))

  console.log(`Installing next and next-server in test-project`)
  await exec(`cd ${TEST_PROJ_PATH} && yarn install`)
}

const statsFailed = message => {
  console.error(`Failed to get stats:`, new Error(message))
  process.exit(1)
}

const getRenderSize = () => {
  console.log(`Fetching page size with "next start"`)

  return new Promise((resolve, reject) => {
    const child = spawn('./node_modules/next/dist/bin/next', ['start'], {
      timeout: 2 * 60 * 1000,
      cwd: TEST_PROJ_PATH,
    })
    let fetchingPage = false
    let pageSize

    const finish = error => {
      if (!child.killed) child.kill()
      if (error) return reject(error)
      resolve(pageSize)
    }

    child.stdout.on('data', async chunk => {
      if (!fetchingPage && /ready on/i.test(chunk.toString())) {
        fetchingPage = true
        const res = await fetch('http://localhost:3000/')
        if (!res.ok) {
          return finish(
            new Error(`Failed to fetch page got status: ${res.status}`)
          )
        }
        pageSize = (await res.text()).length
        finish()
      }
    })

    child.on('exit', code => {
      if (code) finish(new Error(`Error: exited with code ${code}`))
    })
  })
}

/**
 * Generate stats using a specific repo and ref
 * @param {string} repo - path of the repo e.g. zeit/next.js
 * @param {string} ref - ref or branch on repo
 */
const getStats = async (repo, ref, dir, serverless = false) => {
  const nextConfig = join(TEST_PROJ_PATH, 'next.config.js')
  if (serverless) {
    await writeFile(
      nextConfig,
      `
      module.exports = { target: 'serverless' }
    `
    )
  } else {
    await exec(`rm -f ${nextConfig}`)
  }

  let statsResolve
  let statsReject
  const statsPromise = new Promise((resolve, reject) => {
    statsResolve = resolve
    statsReject = reject
  })

  await setupTestProj(dir)

  // Ready to build test-project and get stats
  console.log(`Building test-project using repo ${repo} and ref ${ref}`)

  const stats = {
    cpuUsage: [],
    memUsage: [],
    buildStart: new Date().getTime(),
    nodeModulesSize: await getDirSize(`${TEST_PROJ_PATH}/node_modules`),
  }
  let statsInterval

  const child = spawn('./node_modules/next/dist/bin/next', ['build'], {
    timeout: 5 * 1000 * 60, // 5 minutes
    cwd: TEST_PROJ_PATH,
  })

  statsInterval = setInterval(async () => {
    try {
      const usage = await pidUsage(child.pid)
      stats.cpuUsage.push(usage.cpu)
      stats.memUsage.push(usage.memory)
    } catch (_) {
      // might fail to find pid
    }
  }, 100)

  const cleanUp = hadError => {
    pidUsage.clear()
    clearInterval(statsInterval)
    if (!child.killed) child.kill()
    if (hadError) return statsReject()
    statsResolve()
  }

  child.on('exit', async code => {
    if (code) {
      cleanUp(true)
      return statsFailed(`build process exited with code ${code}`)
    }
    stats.buildEnd = new Date().getTime()
    try {
      if (!serverless) {
        stats.renderSize = await getRenderSize()
      }
      // Get total build output size
      stats.totalBuildSize = await getDirSize(`${TEST_PROJ_PATH}/.next`)
      stats.clientSizes = await getClientSizes(exec, serverless, TEST_PROJ_PATH)
      finishedStats(stats, serverless, COMMENT_API_ENDPOINT, GITHUB_TOKEN, {
        MAIN_REPO,
        MAIN_REF,
        PR_REPO,
        PR_REF,
      })
      cleanUp()
    } catch (error) {
      statsFailed(error.message)
      cleanUp(true)
    }
  })

  child.on('error', error => {
    cleanUp(true)
    statsFailed(error.message)
  })

  child.stderr.on('data', chunk => console.log(chunk.toString()))
  await statsPromise
  console.log()
}

async function run() {
  const mainDir = MAIN_REPO.replace('/', '-')
  const prDir = PR_REPO.replace('/', '-')

  await checkoutRepo(MAIN_REPO, MAIN_REF, mainDir)
  await buildRepo(mainDir)
  console.log()

  await checkoutRepo(PR_REPO, PR_REF, prDir)
  await buildRepo(prDir)
  console.log()

  getStats(MAIN_REPO, MAIN_REF, mainDir)
    .then(() => getStats(PR_REPO, PR_REF, prDir))
    .then(() => {
      currentStats = {}
      prStats = {}
      console.log('Getting serverless stats')
    })
    .then(() => getStats(MAIN_REPO, MAIN_REF, mainDir, true))
    .then(() => getStats(PR_REPO, PR_REF, prDir, true))
    .catch(error => statsFailed(error.message))
}

if (
  MAIN_REPO === PR_REPO &&
  (PR_REF === 'refs/heads/canary' || PR_REF === MAIN_REF)
) {
  console.log('Not running for merge into canary...')
} else run()
