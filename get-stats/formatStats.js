const fetch = require('node-fetch')
const prettyMs = require('pretty-ms')
const prettyBytes = require('pretty-bytes')

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

const formatStats = ({ MAIN_REPO, MAIN_REF, PR_REPO, PR_REF }) => {
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
    // Serverless sizes
    indexServerlessBytes: 'Serverless `index` Size',
    indexServerlessGzip: 'Serverless `index` gzip Size',
    _errorServerlessBytes: 'Serverless `_error` Size',
    _errorServerlessGzip: 'Serverless `_error` gzip Size',

    baseRenderBytes: 'Base Rendered Size',
    totalBuildSize: 'Build Dir Size',
    avgMemUsage: 'Average Memory Usage',
    maxMemUsage: 'Max Memory Usage',
    avgCpuUsage: 'Average CPU Usage',
    maxCpuUsage: 'Max CPU Usage',
    nodeModulesSize: '`node_modules` Size',
  }

  Object.keys(labels).forEach(key => {
    stat1 = currentStats[key]
    stat2 = prStats[key]
    if (typeof stat1 === 'undefined') return
    output += `| ${labels[key]} |`

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

let statsComment = `## Stats from current PR`

const finishedStats = (
  stats,
  serverless,
  commentApiEndpoint,
  githubToken,
  reposObj
) => {
  // Clear stats for serverless
  if (serverless && prStats.buildLength) {
    currentStats = {}
    prStats = {}
  }
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

  if (isPR) {
    const formattedStats = formatStats(reposObj)
    statsComment += `\n\n<details>\n`
    statsComment += `<summary>Click to expand ${
      serverless ? 'serverless ' : ''
    }stats</summary>\n\n`
    statsComment += formattedStats
    statsComment += `\n</details>`

    if (!serverless) return
    console.log('\nFinished!\n')
    console.log(statsComment)
    console.log('Posting stats...')

    fetch(commentApiEndpoint, {
      method: 'POST',
      headers: {
        Authorization: `token ${githubToken}`,
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

module.exports = finishedStats
