const { join } = require('path')
const fetch = require('node-fetch')
const pidUsage = require('pidusage')
const { promisify } = require('util')
const prettyMs = require('pretty-ms')
const Octokit = require('@octokit/rest')
const prettyBytes = require('pretty-bytes')
const { exec: execSync, spawn } = require('child_process')

const exec = promisify(execSync)
const { GITHUB_REPOSITORY, GITHUB_REF } = process.env
const TEST_PROJ_PATH = join(process.cwd(), 'test-project')

const MAIN_REF = 'canary'
const MAIN_REPO = 'zeit/next.js'
const GIT_ROOT = join(process.cwd(), 'origin/')
// const GIT_ROOT = 'https://github.com/'

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

  console.log(`Linking next and next-server`)
  await exec(`cd ${dir}/packages/next && yarn unlink; yarn link`)
  await exec(`cd ${dir}/packages/next-server && yarn unlink; yarn link`)
}

const setupTestProj = async () => {
  console.log(`Cleaning .next and node_modules/.cache in test-project`)
  await exec(`cd ${TEST_PROJ_PATH} && rm -rf .next node_modules/.cache`)
  await exec(`cd ${TEST_PROJ_PATH} && yarn link next next-server`)
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
}
// stats from PR's repo/ref
let prStats = {}

const formatStats = stats => {
  let output = `| Build Duration | Base Page Size | Build Dir Size | Average Memory Usage | Max Memory Usage | Average CPU Usage | Max CPU Usage |\n`
  output += `| - | - | - | - | - | - | - |\n`
  const keys = [
    'buildLength',
    'basePageBytes',
    'totalBuildSize',
    'avgMemUsage',
    'maxMemUsage',
    'avgCpuUsage',
    'maxCpuUsage',
  ]

  keys.forEach((key, idx) => {
    value = stats[key]
    // format memory and page size as bytes
    if (key.indexOf('MemUsage') > -1 || key === 'basePageBytes') {
      value = prettyBytes(value)
    }
    // add percent to CPU usage
    if (key.indexOf('CpuUsage') > -1) {
      value += '%'
    }
    // format buildLength with pretty-ms
    if (key === 'buildLength') {
      value = prettyMs(value)
    }

    if (idx) output += ' '
    else output += '| '

    output += `${value} |`
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
  curStats.totalBuildSize = stats.totalBuildSize
  curStats.basePageBytes = stats.pageSize

  // We're done post stats!
  // TODO: post this as comment
  if (isPR) {
    console.log('\nFinished!')

    console.log(`## Stats from ${MAIN_REPO} ${MAIN_REF}`)
    console.log(formatStats(currentStats))
    console.log()

    console.log(`## Stats from ${GITHUB_REPOSITORY} ${GITHUB_REF}`)
    console.log(formatStats(prStats))
  }
}

const getPageSize = () => {
  console.log(`Fetching page size with "next start"`)

  return new Promise((resolve, reject) => {
    const child = spawn('next', ['start', `${TEST_PROJ_PATH}`], {
      timeout: 2 * 60 * 1000,
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
  await setupTestProj()

  // Ready to build test-project and get stats
  console.log(`Building test-project using repo ${repo} and ref ${ref}`)

  const stats = {
    cpuUsage: [],
    memUsage: [],
    buildStart: new Date().getTime(),
  }
  let statsInterval

  const child = spawn('next', ['build', TEST_PROJ_PATH], {
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
      cleanUp()
      return statsFailed(`build process exited with code ${code}`)
    }
    stats.buildEnd = new Date().getTime()
    try {
      // Get total build output size
      const buildSize = await exec(`du -sh ${TEST_PROJ_PATH}/.next`)
      stats.totalBuildSize = buildSize.stdout.split('\t')[0]
      stats.pageSize = await getPageSize()
      finishedStats(repo, ref, stats)
    } catch (error) {
      statsFailed(error.message)
    }
    cleanUp()
  })

  child.on('error', error => {
    cleanUp()
    statsFailed(error.message)
  })

  child.stderr.on('data', chunk => console.log(chunk.toString()))
  await statsPromise
  console.log()
}

getStats(MAIN_REPO, MAIN_REF)
  .then(() => getStats(GITHUB_REPOSITORY, GITHUB_REF))
  .catch(error => statsFailed(error.message))
