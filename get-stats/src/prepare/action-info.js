const logger = require('../util/logger')

module.exports = function actionInfo() {
  const {
    GITHUB_REF,
    GITHUB_TOKEN,
    GIT_ROOT_DIR,
    GITHUB_ACTION,
    GITHUB_REPOSITORY,
    GITHUB_EVENT_PATH,
    PR_STATS_COMMENT_TOKEN,
  } = process.env

  const info = {
    actionName: GITHUB_ACTION,
    githubToken: GITHUB_TOKEN || PR_STATS_COMMENT_TOKEN,
    commentEndpoint: null,
    gitRoot: GIT_ROOT_DIR, // used for running locally
    prRepo: GITHUB_REPOSITORY,
    prRef: GITHUB_REF,
    isRelease: false,
  }

  // get comment
  if (GITHUB_EVENT_PATH) {
    const event = require(GITHUB_EVENT_PATH)
    info.actionName = event.action || info.actionName
    const releaseTypes = new Set(['release', 'published'])

    if (releaseTypes.has(info.actionName)) {
      info.isRelease = true
    } else {
      // Since GITHUB_REPOSITORY and REF might not match the fork
      // use event data to get repository and ref info
      const prData = event['pull_request']

      if (prData) {
        info.commentEndpoint = prData._links.comments || ''
        info.prRepo = prData.head.repo.full_name
        info.prRef = prData.head.ref

        // comment endpoint might be under `href`
        if (typeof info.commentEndpoint === 'object') {
          info.commentEndpoint = info.commentEndpoint.href
        }
      }
    }
  }

  logger('Got actionInfo:')
  logger.json({
    ...info,
    githubToken: GITHUB_TOKEN
      ? 'GITHUB_TOKEN'
      : PR_STATS_COMMENT_TOKEN && 'PR_STATS_COMMENT_TOKEN',
  })

  return info
}
