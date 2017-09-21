module.exports = { createTrackRouter }

function createTrackRouter (getClient) {
  return router => {
    const trackHandler = function (req, res, next) {
      if (
        typeof getClient === 'undefined' ||
        typeof getClient() === 'undefined'
      ) {
        res.status(404)
        res.json({
          error:
            'signalk-to-influxdb plugin not enabled, http track interface not available'
        })
        return
      }

      const query = `
        select first(value) as "position"
        from "navigation.position"
        where time >= now() - ${sanitize(req.query.timespan || '1h')}
        group by time(${sanitize(req.query.resolution || '1m')})`

      getClient()
        .query(query)
        .then(result => {
          res.type('application/vnd.geo+json')
          res.json(toFeatureCollection(result))
        })
        .catch(err => {
          console.error(err.message + ' ' + query)
          res.status(500).send(err.message + ' ' + query)
        })
    }

    router.get('/vessels/self/tracks', trackHandler)
    return router
  }
}

function toFeatureCollection (result) {
  return {
    type: 'FeatureCollection',
    features: [toFeature(result)]
  }
}

function toFeature (result) {
  console.log(JSON.stringify(result, null, 2))
  return {
    type: 'Feature',
    properties: {
      name: 'Track',
      starttime: result[0].time
    },
    geometry: toMultilineString(result)
  }
}

function toMultilineString (influxResult) {
  let currentLine = []
  const result = {
    type: 'MultiLineString',
    coordinates: []
  }

  influxResult.forEach(row => {
    if (row.position === null) {
      currentLine = []
    } else {
      currentLine.push(JSON.parse(row.position))
      if (currentLine.length === 1) {
        result.coordinates.push(currentLine)
      }
    }
  })
  return result
}

const influxDurationKeys = {
  s: 's',
  m: 'm',
  h: 'h',
  d: 'd',
  w: 'w'
}

function sanitize (influxTime) {
  return (
    Number(influxTime.substring(0, influxTime.length - 1)) +
    influxDurationKeys[
      influxTime.substring(influxTime.length - 1, influxTime.length)
    ]
  )
}
