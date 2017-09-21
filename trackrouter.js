/*
 * Copyright 2017 Teppo Kurki <teppo.kurki@iki.fi>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const debug = require('debug')('signalk:signalk-to-influxdb')
const geolib = require('geolib')

module.exports = { createTrackRouter }

function createTrackRouter (getClient, getPeriods) {
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

      getPeriods(req.query.bbox).then(periods => {
        const queries = periods
          .map(
            period =>
              `
        select first(value) as "position"
        from "navigation.position"
        where
          time >= '${period.start}' AND time <= '${period.end}'
        group by time(${bboxToInfluxTimeResolution(req.query.bbox)})`
          )
          .map(query => query.replace(/\s\s+/g, ' '))
        debug(queries)

        getClient()
          .query(queries)
          .then(result => {
            res.type('application/vnd.geo+json')
            res.json(
              toFeatureCollection(queries.length === 1 ? [result] : result)
            )
          })
          .catch(err => {
            console.error(err.message + ' ' + queries)
            res.status(500).send(err.message + ' ' + queries)
          })
      })
    }

    router.get('/vessels/self/tracks', trackHandler)
    return router
  }
}

function toFeatureCollection (result) {
  return {
    type: 'FeatureCollection',
    features: result.map(toFeature)
  }
}

function toFeature (influxResult) {
  const result = {
    type: 'Feature',
    properties: {
      name: 'Track'
    },
    geometry: toMultilineString(influxResult)
  }
  if (influxResult.length) {
    result.properties.starttime = influxResult[0].time
    result.properties.endtime = influxResult[influxResult.length - 1].time
  }
  return result
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

const lengthToInfluxResolution = [
  [2 * 1000, '1s'],
  [20 * 1000, '10s'],
  [200 * 1000, '1m'],
  [1000 * 1000, '1h'],
  [10000000 * 1000, '1d']
]

function bboxToInfluxTimeResolution (bboxString) {
  const bounds = bboxString.split(',')
  const distance = geolib.getDistance(
    { longitude: bounds[0], latitude: bounds[1] },
    { longitude: bounds[2], latitude: bounds[3] }
  )
  debug(distance)
  return lengthToInfluxResolution.find(x => distance < x[0])[1]
}
