const fs = require('fs')
const { join } = require('path')
const fetch = require('node-fetch')
const pidUsage = require('pidusage')
const { promisify } = require('util')
const prettyMs = require('pretty-ms')
const Octokit = require('@octokit/rest')
const getDirSize = require('./getDirSize')
const prettyBytes = require('pretty-bytes')
const { exec: execSync, spawn } = require('child_process')

const exec = promisify(execSync)
const { GITHUB_REPOSITORY, GITHUB_REF } = process.env
const TEST_PROJ_PATH = join(process.cwd(), 'test-project')

const MAIN_REF = 'canary'
const MAIN_REPO = 'zeit/next.js'
const GIT_ROOT = 'https://github.com/'

if (!GITHUB_REPOSITORY || !GITHUB_REF) {
  throw new Error(
    `'GITHUB_REF' or 'GITHUB_REPOSITORY' environment variable was missing`
  )
}

console.log(
  `Got repo url: ${GITHUB_REPOSITORY} and branch/ref: ${GITHUB_REF}\n`
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
  // TODO: will also probably want to submit a comment with error
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
  basePageBytes: null,
  totalBuildSize: null,
  nodeModulesSize: null,
}
// stats from PR's repo/ref
let prStats = {}

const formatStats = () => {
  let output = `| | ${MAIN_REPO} ${MAIN_REF} | ${GITHUB_REPOSITORY} ${GITHUB_REF} |\n`
  output += `| - | - | - |\n`

  const labels = {
    buildLength: 'Build Duration',
    basePageBytes: 'Base Page Size',
    totalBuildSize: 'Build Dir Size',
    avgMemUsage: 'Average Memory Usage',
    maxMemUsage: 'Max Memory Usage',
    avgCpuUsage: 'Average CPU Usage',
    maxCpuUsage: 'Max CPU Usage',
    nodeModulesSize: 'node_modules Size',
  }

  Object.keys(labels).forEach((key, idx) => {
    output += `| ${labels[key]} |`
    stat1 = currentStats[key]
    stat2 = prStats[key]
    // format memory and page size as bytes
    if (
      key.indexOf('MemUsage') > -1 ||
      key === 'basePageBytes' ||
      key === 'nodeModulesSize' ||
      key === 'totalBuildSize'
    ) {
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

    output += ` ${stat1} | ${stat2} |\n`
  })

  return output
}

const finishedStats = (repo, ref, stats) => {
  const isPR = repo === GITHUB_REPOSITORY && ref === GITHUB_REF
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
  curStats.basePageBytes = stats.pageSize

  // We're done post stats!
  // TODO: post this as comment
  if (isPR) {
    console.log('\nFinished!\n')
    console.log(`## Stats from current PR`)
    console.log(formatStats())
  }
}

const getPageSize = () => {
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
      stats.pageSize = await getPageSize()
      finishedStats(repo, ref, stats)
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

// getStats(MAIN_REPO, MAIN_REF)
//   .then(() => getStats(GITHUB_REPOSITORY, GITHUB_REF))
//   .catch(error => statsFailed(error.message))

console.log('process.env', process.env)
console.log(`----------------------------------------`)
console.log(
  'event.json',
  fs.readFileSync(process.env['GITHUB_EVENT_PATH'], 'utf8')
)
