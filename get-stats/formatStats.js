const fetch = require('node-fetch')
const prettyMs = require('pretty-ms')
const prettyBytes = require('pretty-bytes')

// stats from main repo/ref
let currentStats = {
  // avg bytes of memory used
  // avgMemUsage: null,
  // maximum bytes of memory used
  // maxMemUsage: null,
  // avg CPU percent used
  // avgCpuUsage: null,
  // maximum CPU percent used
  // maxCpuUsage: null,
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
    nodeModulesSize: '`node_modules` Size',
    totalBundleBytes: 'Total Bundle (main, webpack, commons) Size',
    totalBundleGzip: 'Total Bundle (main, webpack, commons) gzip Size',
    totalBundleModernBytes: 'Total Bundle (main, webpack, commons) Modern Size',
    totalBundleModernGzip:
      'Total Bundle (main, webpack, commons) Modern gzip Size',

    // Client sizes
    _appClientBytes: 'Client `_app` Size',
    _appClientGzip: 'Client `_app` gzip Size',
    _appClientBytesModern: 'Client `_app` Modern Size',
    _appClientGzipModern: 'Client `_app` gzip Modern Size',
    _errClientBytes: 'Client `_error` Size',
    _errClientGzip: 'Client `_error` gzip Size',
    _errClientBytesModern: 'Client `_error` Modern Size',
    _errClientGzipModern: 'Client `_error` gzip Modern Size',
    indexClientBytes: 'Client `pages/index` Size',
    indexClientGzip: 'Client `pages/index` gzip Size',
    indexClientBytesModern: 'Client `pages/index` Modern Size',
    indexClientGzipModern: 'Client `pages/index` gzip Modern Size',
    linkPgClientBytes: 'Client `pages/link` Size',
    linkPgClientGzip: 'Client `pages/link` gzip Size',
    linkPgClientBytesModern: 'Client `pages/link` Modern Size',
    linkPgClientGzipModern: 'Client `pages/link` gzip Modern Size',
    routerPgClientBytes: 'Client `pages/routerDirect` Size',
    routerPgClientGzip: 'Client `pages/routerDirect` gzip Size',
    routerPgClientBytesModern: 'Client `pages/routerDirect` Modern Size',
    routerPgClientGzipModern: 'Client `pages/routerDirect` gzip Modern Size',
    withRouterPgClientBytes: 'Client `pages/withRouter` Size',
    withRouterPgClientGzip: 'Client `pages/withRouter` gzip Size',
    withRouterPgClientBytesModern: 'Client `pages/withRouter` Modern Size',
    withRouterPgClientGzipModern: 'Client `pages/withRouter` gzip Modern Size',

    clientMainBytes: 'Client `main` Size',
    clientMainGzip: 'Client `main` gzip Size',
    clientMainModernBytes: 'Client `main` Modern Size',
    clientMainModernGzip: 'Client `main` Modern gzip Size',
    commonChunkBytes: 'Client `commons` Size',
    commonChunkGzip: 'Client `commons` gzip Size',
    commonChunkModernBytes: 'Client `commons` Modern Size',
    commonChunkModernGzip: 'Client `commons` Modern gzip Size',
    clientWebpackBytes: 'Client `webpack` Size',
    clientWebpackGzip: 'Client `webpack` gzip Size',
    clientWebpackModernBytes: 'Client `webpack` Modern Size',
    clientWebpackModernGzip: 'Client `webpack` Modern gzip Size',

    // Serverless sizes
    linkPgServerlessBytes: 'Serverless `pages/link` Size',
    linkPgServerlessGzip: 'Serverless `pages/link` gzip Size',
    indexServerlessBytes: 'Serverless `pages/index` Size',
    indexServerlessGzip: 'Serverless `pages/index` gzip Size',
    _errorServerlessBytes: 'Serverless `pages/_error` Size',
    _errorServerlessGzip: 'Serverless `pages/_error` gzip Size',
    routerPgServerlessBytes: 'Serverless `pages/routerDirect` Size',
    routerPgServerlessGzip: 'Serverless `pages/routerDirect` gzip Size',
    withRouterPgServerlessBytes: 'Serverless `pages/withRouter` Size',
    withRouterPgServerlessGzip: 'Serverless `pages/withRouter` gzip Size',

    baseRenderBytes: 'Base Rendered Size',
    totalBuildSize: 'Build Dir Size',
    // avgMemUsage: 'Average Memory Usage',
    // maxMemUsage: 'Max Memory Usage',
    // avgCpuUsage: 'Average CPU Usage',
    // maxCpuUsage: 'Max CPU Usage',
  }

  Object.keys(labels).forEach(key => {
    stat1 = currentStats[key]
    stat2 = prStats[key]
    if (typeof stat1 === 'undefined') return
    output += `| ${labels[key]} |`

    let diff = '✓' // start with no change
    if (stat1 !== stat2) {
      diff = Math.round((stat2 - stat1) * 100) / 100
      // below is for percentage
      // const diffPerc = ((stat2 - stat1) / stat1) * 100
      // const diffDir = diffPerc < 0 ? '' : '⚠️  +'
      // diff = `${diffDir}${Math.round(diffPerc * 100) / 100}%`
    }
    let formatter = stat => stat

    // format memory and page size as bytes
    if (/.(MemUsage|Bytes|Size|Gzip)/.test(key)) {
      formatter = stat => prettyBytes(stat)
    }
    // add percent to CPU usage
    if (key.indexOf('CpuUsage') > -1) {
      formatter = stat => `${stat}%`
    }
    // format buildLength with pretty-ms
    if (key === 'buildLength') {
      formatter = stat => prettyMs(stat)
    }
    if (typeof stat1 === 'number') stat1 = formatter(stat1)
    if (typeof stat2 === 'number') stat2 = formatter(stat2)
    if (typeof diff === 'number' && !isNaN(diff)) {
      const diffSign = diff < 0 ? '-' : '⚠️  +'
      diff = formatter(Math.abs(diff))
      diff = diffSign + diff
    }

    output += ` ${stat1} | ${stat2} | ${diff} |\n`
  })

  return output
}

let statsComment = `## Stats from current PR`
let diffContent = ''

const finishedStats = (
  diff,
  stats,
  serverless,
  isCanaryRelease,
  commentApiEndpoint,
  githubToken,
  reposObj
) => {
  if (isCanaryRelease && statsComment.indexOf('current PR') > -1) {
    statsComment = '## Stats from current release'
  }
  // Clear stats for serverless or diff
  if ((serverless || diff) && prStats.buildLength) {
    currentStats = {}
    prStats = {}
  }
  const { diffs } = stats.clientSizes
  const isPR = Boolean(currentStats.buildLength)
  const curStats = isPR ? prStats : currentStats
  const numUsage = stats.memUsage.length

  if (diffs && isPR) {
    let diffLength = 0
    const files = Object.keys(diffs)
    const formattedDiffs = {}

    for (const file of files) {
      const content = diffs[file]
      if (!content) continue

      diffLength += content.length
      formattedDiffs[file] = `<details>
        <summary>Diff for <strong>${file}</strong></summary>${'\n\n```diff\n' +
        content +
        '\n```\n'}</details>
      `
    }

    if (diffLength > 150 * 1000) {
      for (const file of files) {
        if (diffs[file].length > 50 * 1000) {
          diffLength -= diffs[file].length
          formattedDiffs[
            file
          ] = `Diff for <strong>${file}</strong> - Too large to display`
        }
        if (diffLength < 150 * 1000) break
      }
    }
    diffContent = files.map(file => formattedDiffs[file]).join('\n')
    // update buildLength so it's reset for the next run
    curStats.buildLength = 1
    // finished generating diffs return for serverless stats
    return
  }

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
  curStats.totalBundleBytes = 0
  curStats.totalBundleGzip = 0
  curStats.totalBundleModernGzip = 0
  curStats.totalBundleModernBytes = 0

  const bundleKeys = [
    'indexClientBytes',
    '_appClientBytes',
    'clientMainBytes',
    'commonChunkBytes',
  ]
  const bundleByteKeys = new Set(bundleKeys)
  const bundleGzipKeys = new Set(
    bundleKeys.map(k => k.replace(/Bytes$/, 'Gzip'))
  )
  const bundleModernKeys = new Set(
    bundleKeys.map(k => k.replace(/Bytes$/, 'ModernBytes'))
  )
  const bundleGzipModernKeys = new Set(
    bundleKeys.map(k => k.replace(/Bytes$/, 'ModernGzip'))
  )

  Object.keys(stats.clientSizes).forEach(key => {
    curStats[key] = stats.clientSizes[key]
    const val =
      typeof stats.clientSizes[key] === 'number' ? stats.clientSizes[key] : 0

    if (bundleByteKeys.has(key)) curStats.totalBundleBytes += val
    if (bundleGzipKeys.has(key)) curStats.totalBundleGzip += val
    if (bundleModernKeys.has(key)) curStats.totalBundleModernBytes += val
    if (bundleGzipModernKeys.has(key)) curStats.totalBundleModernGzip += val
  })

  if (isPR) {
    let runDiff = false
    let summaryPostText = ''

    if (currentStats.totalBundleBytes < prStats.totalBundleBytes) {
      summaryPostText = ' ⚠️ Total Bundle Size Increase ⚠️'
    }
    if (currentStats.totalBundleBytes > prStats.totalBundleBytes) {
      summaryPostText = ' ✅ Total Bundle Size Decrease ✅'
    }

    // show modern change if not normal bundle change
    if (
      !summaryPostText &&
      currentStats.totalBundleModernBytes < prStats.totalBundleModernBytes
    ) {
      summaryPostText = ' ⚠️ Total Modern Bundle Size Increase ⚠️'
    }
    if (
      !summaryPostText &&
      currentStats.totalBundleModernBytes > prStats.totalBundleModernBytes
    ) {
      summaryPostText = ' ✅ Total Modern Bundle Size Decrease ✅'
    }

    runDiff = summaryPostText && !serverless && !diff
    const formattedStats = formatStats(reposObj)

    statsComment += `\n\n<details>\n`
    statsComment += `<summary>Click to expand ${
      serverless ? 'serverless ' : ''
    }stats${summaryPostText}</summary>\n\n`
    statsComment += formattedStats
    statsComment += `\n</details>\n`

    if (!serverless) return runDiff
    statsComment += diffContent

    console.log('\nFinished!\n')
    console.log(statsComment)
    console.log('Posting stats to endpoint:', commentApiEndpoint)

    if (commentApiEndpoint && githubToken) {
      fetch(commentApiEndpoint, {
        method: 'POST',
        headers: {
          Authorization: `bearer ${githubToken}`,
        },
        body: JSON.stringify({
          body: statsComment,
        }),
      })
        .then(async res => {
          if (res.ok) {
            console.log('Posted comment with stats!')
          } else {
            console.error('Failed to post comment', res.status)
            try {
              console.error(await res.text())
            } catch (_) {}
          }
        })
        .catch(err => {
          console.error('Error occurred posting comment', err)
        })
    } else {
      console.log(
        `${
          githubToken ? 'No comment endpoint' : 'No github token'
        }, not posting`
      )
    }
  }
}

module.exports = finishedStats
