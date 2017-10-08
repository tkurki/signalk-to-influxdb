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
          error: 'signalk-to-influxdb plugin not enabled, http track interface not available'
        })
        return
      }

      getPeriods(req.query.bbox)
        .then(periods => {
          let dataPaths = []
          const queries = periods
            .reduce((acc, period) => {
              acc.push(
                `
              select first(value) as "position"
              from "navigation.position"
              where
                time >= '${period.start}' AND time <= '${period.end}'
              group by time(${bboxToInfluxTimeResolution(req.query.bbox)})`
              )

              if (req.query.paths) {
                dataPaths = req.query.paths.split(',')
                dataPaths.forEach(dataPath => {
                  acc.push(
                    `
                  select min(value) as "value"
                  from "${dataPath}"
                  where
                    time >= '${period.start}' AND time <= '${period.end}'
                  group by time(${bboxToInfluxTimeResolution(req.query.bbox)})`
                  )
                })
              }
              return acc
            }, [])
            .map(query => query.replace(/\s\s+/g, ' '))
          debug(queries)

          return getClient().query(queries).then(results => {
            res.type('application/vnd.geo+json')
            try {
              const featureCollection = toFeatureCollection(
                periods, 
                queries.length === 1 ? [results] : results,
                dataPaths
              )
              res.json(featureCollection)
            } catch (ex) {
              console.log(ex)
              console.log(ex.stack)
              throw ex
            }
          })
        })
        .catch(err => {
          console.error(err.message + ' ' + req.query)
          res.status(500).send(err.message + ' ' + req.query)
        })
    }

    router.get('/vessels/self/tracks', trackHandler)
    return router
  }
}

function toFeatureCollection (tracks, results, dataPaths) {
  //we get (datapaths.length + 1) x tracks.length results:
  //one for each track's positions and one per datapath
  return {
    type: 'FeatureCollection',
    properties: {
      dataPaths: dataPaths
    },
    features: results.reduce((acc, result, index) => {
      if (index % (dataPaths.length + 1) === 0) {
        acc.push(toFeature(tracks[index % (dataPaths.length + 1)], result))
      } else {
        pushRowValuesToCoordinates(acc[acc.length - 1], result)
      }
      return acc
    }, [])
  }
}

function toFeature (track, influxResult) {
  const result = {
    type: 'Feature',
    properties: {
      id: track.id,
      startTime: track.start,
      endTime: track.end,
      name: 'Track'
    },
    geometry: toMultilineString(influxResult)
  }
  if (influxResult.length) {
    result.properties.clippedStartTime = influxResult[0].time
    result.properties.clippedEndTime = influxResult[influxResult.length - 1].time
  }
  return result
}

function toMultilineString (influxResult) {
  let currentLine = []
  const result = {
    type: 'MultiLineString',
    coordinates: [currentLine]
  }

  influxResult.forEach(row => {
    if (row.position) {
      currentLine.push(JSON.parse(row.position))
      currentLine[currentLine.length - 1][2] = 0
      currentLine[currentLine.length - 1][3] = row.time.getTime()
    }
  })
  return result
}

function pushRowValuesToCoordinates (feature, influxResult) {
  let i = 0
  influxResult.forEach(row => {
    const dataTime = row.time.getTime()
    if (
      feature.geometry.coordinates[0][i] &&
      dataTime === feature.geometry.coordinates[0][i][3]
    ) {
      feature.geometry.coordinates[0][i].push(row.value)
      i++
    }
  })
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
