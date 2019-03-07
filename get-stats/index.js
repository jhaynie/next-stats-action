const { join } = require('path')
const fetch = require('node-fetch')
const pidUsage = require('pidusage')
const { promisify } = require('util')
const prettyMs = require('pretty-ms')
const prettyBytes = require('pretty-bytes')
const { exec: execSync, spawn } = require('child_process')
const { getDirSize, getClientSizes } = require('./getSizes')

const execP = promisify(execSync)
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
  console.log(`Installing next and next-server in test-project`)
  await exec(`rm -rf ${TEST_PROJ_PATH}/node_modules/next`)
  await exec(`rm -rf ${TEST_PROJ_PATH}/node_modules/next-server`)

  await exec(`mv ${repoDir}/packages/next/ ${TEST_PROJ_PATH}/node_modules/`)
  await exec(
    `mv ${repoDir}/packages/next-server/ ${TEST_PROJ_PATH}/node_modules/`
  )

  await exec(`cd ${TEST_PROJ_PATH}/node_modules/next && rm -rf node_modules`)
  await exec(
    `cd ${TEST_PROJ_PATH}/node_modules/next-server && rm -rf node_modules`
  )

  await exec(
    `cd ${TEST_PROJ_PATH}/node_modules/next && yarn install --production`
  )
  await exec(
    `cd ${TEST_PROJ_PATH}/node_modules/next-server && yarn install --production`
  )

  console.log(`Cleaning .next and node_modules/.cache in test-project`)
  await exec(`cd ${TEST_PROJ_PATH} && rm -rf .next node_modules/.cache`)
}

const statsFailed = message => {
  console.error(`Failed to get stats:`, message)
  process.exit(1)
}

// stats from main repo/reef
let currentStats = {
  // avg bytes of memory used
  avgMemUsage: null,
  // maximum bytes of memory used
  maxMemUsage: null,
  // avg CPU percent used
  avgCpuUsage: null,
  // maximum CPU percent used
  maxCpuUsage: null,
  // in milliseconds
  buildLength: null,
  totalBuildSize: null,
  nodeModulesSize: null,
  // Client bundle gzip sizes
  _appClientGzip: null,
  _errClientGzip: null,
  indexClientGzip: null,
  clientMainGzip: null,
  commonChunkGzip: null,
  clientWebpackGzip: null,
  // Client bundle raw sizes
  _appClientBytes: null,
  _errClientBytes: null,
  indexClientBytes: null,
  commonChunkBytes: null,
  clientMainBytes: null,
  clientWebpackBytes: null,
  baseRenderBytes: null,
}
// stats from PR's repo/ref
let prStats = {}

const formatStats = () => {
  let output = `| | ${MAIN_REPO} ${MAIN_REF} | ${PR_REPO} ${PR_REF} | Change |\n`
  output += `| - | - | - | - |\n`

  const labels = {
    buildLength: 'Build Duration',
    // Client sizes
    _appClientBytes: 'Client `_app` Size',
    _appClientGzip: 'Client `_app` gzip Size',
    _errClientBytes: 'Client `_error` Size',
    _errClientGzip: 'Client `_error` gzip Size',
    indexClientBytes: 'Client `pages/index` Size',
    indexClientGzip: 'Client `pages/index` gzip Size',
    clientMainBytes: 'Client `main` Size',
    clientMainGzip: 'Client `main` gzip Size',
    commonChunkBytes: 'Client `commons` Size',
    commonChunkGzip: 'Client `commons` gzip Size',
    clientWebpackBytes: 'Client `webpack` Size',
    clientWebpackGzip: 'Client `webpack` gzip Size',
    baseRenderBytes: 'Base Rendered Size',
    totalBuildSize: 'Build Dir Size',
    avgMemUsage: 'Average Memory Usage',
    maxMemUsage: 'Max Memory Usage',
    avgCpuUsage: 'Average CPU Usage',
    maxCpuUsage: 'Max CPU Usage',
    nodeModulesSize: '`node_modules` Size',
  }

  Object.keys(labels).forEach((key, idx) => {
    output += `| ${labels[key]} |`
    stat1 = currentStats[key]
    stat2 = prStats[key]
    let diff = '✓' // start with no change
    if (stat1 !== stat2) {
      const diffPerc = ((stat2 - stat1) / stat1) * 100
      const diffDir = diffPerc < 0 ? '' : '⚠️  +'
      diff = `${diffDir}${Math.round(diffPerc * 100) / 100}%`
    }

    // format memory and page size as bytes
    if (/.(MemUsage|Bytes|Size|Gzip)/.test(key)) {
      stat1 = prettyBytes(stat1)
      stat2 = prettyBytes(stat2)
    }
    // add percent to CPU usage
    if (key.indexOf('CpuUsage') > -1) {
      stat1 += '%'
      stat2 += '%'
    }
    // format buildLength with pretty-ms
    if (key === 'buildLength') {
      stat1 = prettyMs(stat1)
      stat2 = prettyMs(stat2)
    }

    output += ` ${stat1} | ${stat2} | ${diff} |\n`
  })

  return output
}

const finishedStats = stats => {
  const isPR = Boolean(currentStats.buildLength)
  const curStats = isPR ? prStats : currentStats
  const numUsage = stats.memUsage.length

  // Calculate Max/Avg for memory and cpu percent
  for (let i = 0; i < numUsage; i++) {
    const curMem = stats.memUsage[i]
    const curCpu = stats.cpuUsage[i]

    if (!curStats.avgCpuUsage) {
      curStats.avgCpuUsage = curCpu
      curStats.maxCpuUsage = curCpu
    } else {
      curStats.avgCpuUsage += curCpu
      curStats.maxCpuUsage =
        curStats.maxCpuUsage > curCpu ? curStats.maxCpuUsage : curCpu
    }

    if (!curStats.avgMemUsage) {
      curStats.avgMemUsage = curMem
      curStats.maxMemUsage = curMem
    } else {
      curStats.avgMemUsage += curMem
      curStats.maxMemUsage =
        curStats.maxMemUsage > curMem ? curStats.maxMemUsage : curMem
    }
  }
  const roundFactor = Math.pow(10, 2) // round to 2 decimal points
  const round = num => Math.round(num * roundFactor) / roundFactor

  curStats.maxCpuUsage = round(curStats.maxCpuUsage)
  curStats.avgCpuUsage = round(curStats.avgCpuUsage / numUsage)
  curStats.avgMemUsage = parseInt(curStats.avgMemUsage / numUsage)
  curStats.buildLength = stats.buildEnd - stats.buildStart
  curStats.nodeModulesSize = stats.nodeModulesSize
  curStats.totalBuildSize = stats.totalBuildSize
  curStats.baseRenderBytes = stats.renderSize

  Object.keys(stats.clientSizes).forEach(key => {
    curStats[key] = stats.clientSizes[key]
  })

  // We're done post stats!
  if (isPR) {
    const formattedStats = formatStats()
    let statsComment = `## Stats from current PR\n`
    statsComment += `<details>\n`
    statsComment += `<summary>Click to expand stats</summary>\n\n`
    statsComment += formattedStats
    statsComment += `\n</details>`

    console.log('\nFinished!\n')
    console.log(statsComment)
    console.log('Posting stats...')

    fetch(COMMENT_API_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
      },
      body: JSON.stringify({
        body: statsComment,
      }),
    })
      .then(res => {
        if (res.ok) {
          console.log('Posted comment with stats!')
        } else {
          console.error('Failed to post comment', res.status)
        }
      })
      .catch(err => {
        console.error('Error occurred posting comment', err)
      })
  }
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
const getStats = async (repo, ref) => {
  const dir = repo.replace('/', '-')

  let statsResolve
  let statsReject
  const statsPromise = new Promise((resolve, reject) => {
    statsResolve = resolve
    statsReject = reject
  })

  await checkoutRepo(repo, ref, dir)
  await buildRepo(dir)
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
      // Get total build output size
      stats.totalBuildSize = await getDirSize(`${TEST_PROJ_PATH}/.next`)
      stats.renderSize = await getRenderSize()
      stats.clientSizes = await getClientSizes(exec, TEST_PROJ_PATH)
      finishedStats(stats)
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

if (
  MAIN_REPO === PR_REPO &&
  (PR_REF === 'refs/heads/canary' || PR_REF === MAIN_REF)
) {
  console.log('Not running for merge into canary...')
} else {
  getStats(MAIN_REPO, MAIN_REF)
    .then(() => getStats(PR_REPO, PR_REF))
    .catch(error => statsFailed(error.message))
}
