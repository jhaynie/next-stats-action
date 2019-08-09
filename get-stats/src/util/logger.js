function logger (...args) {
  if (args.length > 1) args = ['\n', ...args, '\n']
  console.log(...args)
}

logger.json = (obj) => {
  logger(JSON.stringify(obj, null, 2))
}

logger.error = (...args) => {
  console.error(...args)
}

logger.warn = (...args) => {
  console.warn(...args)
}

module.exports = logger
