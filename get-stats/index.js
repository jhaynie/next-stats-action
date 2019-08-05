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
const exec = cmd => execP(cmd, { env: { ...process.env, GITHUB_TOKEN: '', PR_STATS_TEMP_TOKEN: '' } })

const {
  GITHUB_ACTION,
  GITHUB_EVENT_PATH,
  GITHUB_REPOSITORY,
  GITHUB_REF,
  GIT_ROOT_DIR,
  PR_STATS_TEMP_TOKEN
} = process.env

const GITHUB_TOKEN = PR_STATS_TEMP_TOKEN || process.env.GITHUB_TOKEN
const TEST_PROJ_PATH = join(__dirname, '../test-project')
let PR_REPO = GITHUB_REPOSITORY
let PR_REF = GITHUB_REF
let COMMENT_API_ENDPOINT
let ACTION = GITHUB_ACTION
let EVENT_DATA

if (GITHUB_EVENT_PATH) {
  EVENT_DATA = require(GITHUB_EVENT_PATH)
  ACTION = EVENT_DATA['action']

  if (ACTION !== 'published' && ACTION !== 'release') {
    const PR_DATA = EVENT_DATA['pull_request']

    if (PR_DATA) {
      // Since GITHUB_REPOSITORY and REF might not match the fork
      // use event data to get repo and ref info
      PR_REPO = PR_DATA['head']['repo']['full_name']
      PR_REF = PR_DATA['head']['ref']
      COMMENT_API_ENDPOINT = PR_DATA['_links']['comments']
    }
  }
}

let MAIN_REF = 'canary'
const MAIN_REPO = 'zeit/next.js'
const GIT_ROOT = GIT_ROOT_DIR || 'https://github.com/'
const RELEASE_TAG = GITHUB_REF
const isCanaryRelease =
  (ACTION === 'published' || ACTION === 'release') &&
  RELEASE_TAG.indexOf('canary') > -1

if (isCanaryRelease) {
  PR_REPO = MAIN_REPO
  PR_REF = MAIN_REF
  MAIN_REF = 'master'
}

if (!GITHUB_REPOSITORY || !GITHUB_REF) {
  throw new Error(
    `'GITHUB_REF' or 'GITHUB_REPOSITORY' environment variable was missing`
  )
}

if (ACTION !== 'synchronize' && ACTION !== 'opened' && !isCanaryRelease) {
  console.log(
    'Not running for',
    ACTION,
    'event action on repo:',
    PR_REPO,
    'and ref:',
    PR_REF
  )
  process.exit(0)
}

console.log(
  `Got repo url: ${GITHUB_REPOSITORY} and branch/ref: ${GITHUB_REF}\n` +
    `Using repo url: ${PR_REPO} and branch/ref: ${PR_REF}\n`
)

const resetHead = async (repoDir, headTarget) => {
  console.log(`Resetting head of ${repoDir} to ${headTarget}`)
  await exec(`cd ${repoDir} && git reset --hard ${headTarget}`)
  const { stdout: commitSHA } = await exec(`git rev-parse HEAD`)
  return commitSHA
}

const checkoutRepo = async (repo, ref, outDir, mainDir) => {
  const url = GIT_ROOT + repo
  console.log(`Cloning ${url} to ${outDir}`)
  await exec(`rm -rf ${outDir}`)
  await exec(`git clone ${url} ${outDir}`)
  await exec(`cd ${outDir} && git checkout ${ref}`)

  // auto merge canary to PR branches if possible
  if (ref !== MAIN_REF && !isCanaryRelease) {
    console.log('Attempting auto merging of canary into', ref)
    await exec(`cd ${outDir} && git remote add upstream ../${mainDir}`)
    await exec(`cd ${outDir} && git fetch upstream`)

    try {
      await exec(`cd ${outDir} && git merge upstream/canary`)
      console.log('Auto merged canary successfully')
    } catch (err) {
      console.log('Failed to auto merge canary:\n', err.stdout)

      if (err.stdout && err.stdout.includes('CONFLICT')) {
        await exec(`cd ${outDir} && git merge --abort`)
        console.log('Aborted merge...')
      }
    }
  }
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

const statsFailed = (message, err) => {
  console.error(`Failed to get stats:`, err || new Error(message))
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

const getStats = async (repo, ref, dir, serverless = false, diff = false) => {
  const nextConfig = join(TEST_PROJ_PATH, 'next.config.js')
  if (serverless) {
    await writeFile(
      nextConfig,
      `
      module.exports = { target: 'serverless' }
    `
    )
  } else if (diff) {
    // disable minifying for diffing
    await writeFile(
      nextConfig,
      `
      module.exports = {
        webpack(config) {
          config.optimization.minimize = false
          config.optimization.minimizer = undefined
          return config
        }
      }
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

  const cleanUp = (hadError, runDiff) => {
    pidUsage.clear()
    clearInterval(statsInterval)
    if (!child.killed) child.kill()
    if (hadError) return statsReject()
    statsResolve(runDiff)
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
      stats.clientSizes = await getClientSizes(
        exec,
        serverless,
        TEST_PROJ_PATH,
        diff,
        MAIN_REF !== ref
      )
      const runDiff = finishedStats(
        diff,
        stats,
        serverless,
        isCanaryRelease,
        COMMENT_API_ENDPOINT,
        GITHUB_TOKEN,
        {
          MAIN_REPO,
          MAIN_REF,
          PR_REPO,
          PR_REF: isCanaryRelease ? RELEASE_TAG : PR_REF,
          isCanaryRelease,
        }
      )
      cleanUp(false, runDiff)
    } catch (error) {
      statsFailed(null, error)
      cleanUp(true)
    }
  })

  child.on('error', error => {
    cleanUp(true)
    statsFailed(null, error)
  })

  child.stderr.on('data', chunk => console.log(chunk.toString()))

  return statsPromise.then(res => {
    console.log()
    return res
  })
}

async function run() {
  const mainDir = MAIN_REPO.replace('/', '-')
  let prDir = PR_REPO.replace('/', '-')
  if (mainDir === prDir) prDir += '-1'

  await checkoutRepo(MAIN_REPO, MAIN_REF, mainDir)
  await buildRepo(mainDir)
  console.log()

  await checkoutRepo(PR_REPO, PR_REF, prDir, mainDir)

  if (isCanaryRelease) {
    // reset to latest canary tag getting commit id
    const commitSHA = await resetHead(prDir, RELEASE_TAG)
    COMMENT_API_ENDPOINT = `https://api.github.com/repos/${MAIN_REPO}/commits/${commitSHA.trim()}/comments`
  }
  await buildRepo(prDir)
  console.log()

  getStats(MAIN_REPO, MAIN_REF, mainDir)
    .then(() => getStats(PR_REPO, PR_REF, prDir))
    .then(async runDiff => {
      if (runDiff) {
        console.log('Got bundle size increase, running diff\n')
        await exec(`rm -rf ${join(TEST_PROJ_PATH, '..', 'diff')}`)
        await getStats(MAIN_REPO, MAIN_REF, mainDir, false, true)
        await getStats(PR_REPO, PR_REF, prDir, false, true)
      }
      console.log('Getting serverless stats')
    })
    .then(() => getStats(MAIN_REPO, MAIN_REF, mainDir, true))
    .then(() => getStats(PR_REPO, PR_REF, prDir, true))
    .catch(error => statsFailed(null, error))
}

if (
  !isCanaryRelease &&
  MAIN_REPO === PR_REPO &&
  (PR_REF === 'refs/heads/canary' || PR_REF === MAIN_REF)
) {
  console.log('Not running for merge into canary...')
} else {
  run()
}
